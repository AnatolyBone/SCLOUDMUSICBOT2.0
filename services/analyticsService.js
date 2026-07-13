// services/analyticsService.js

import { query } from '../db.js';
import redisService from './redisClient.js';
import { randomUUID } from 'crypto';

/**
 * Возвращает текущую московскую дату в формате YYYY-MM-DD
 */
export function getMoscowDateString() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
}

/**
 * Возвращает количество секунд, оставшихся до следующей полуночи по московскому времени
 */
export function getSecondsUntilMoscowMidnight() {
  const now = new Date();
  
  // Создаем объект даты для следующего дня
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  
  // Получаем строковое представление завтрашнего дня в Москве в формате YYYY-MM-DD
  const moscowTomorrowStr = tomorrow.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
  
  // Конструируем объект даты для полуночи завтрашнего дня в часовом поясе Москвы (UTC+3)
  const moscowMidnight = new Date(`${moscowTomorrowStr}T00:00:00+03:00`);
  
  // Разница в секундах
  const seconds = Math.ceil((moscowMidnight.getTime() - now.getTime()) / 1000);
  return Math.max(seconds, 0);
}

class AnalyticsService {
  /**
   * Получает или генерирует session_id для пользователя с TTL 30 минут в Redis
   */
  async getSessionId(userId) {
    if (!userId) return null;
    const redisKey = `session:${userId}`;
    try {
      if (redisService.client && redisService.client.isOpen) {
        let sessionId = await redisService.client.get(redisKey);
        if (!sessionId) {
          sessionId = randomUUID();
          await redisService.client.set(redisKey, sessionId, { EX: 1800 }); // 30 минут
        } else {
          await redisService.client.expire(redisKey, 1800);
        }
        return sessionId;
      }
    } catch (e) {
      console.error('[Analytics] Error getting session ID from Redis:', e.message);
    }
    return randomUUID(); // Временный UUID, если Redis недоступен
  }

  /**
   * Записывает аналитическое событие в БД
   */
  async trackEvent(userId, eventName, category, eventData = {}, ctx = null) {
    try {
      const sessionId = await this.getSessionId(userId);
      
      let userPlan = 'Free';
      let languageCode = null;
      let acquisitionSource = null;
      let eventSource = 'direct';
      let placement = null;
      let campaignId = null;
      let dedupKey = null;

      // Извлекаем метаданные из события, если они переданы
      if (eventData) {
        if (eventData.event_source) eventSource = eventData.event_source;
        if (eventData.placement) placement = eventData.placement;
        if (eventData.campaign_id) campaignId = eventData.campaign_id;
        if (eventData.deduplication_key) dedupKey = eventData.deduplication_key;
      }

      // Извлекаем данные из Telegraf-контекста, если он есть
      if (ctx) {
        const user = ctx.state?.user;
        if (user) {
          acquisitionSource = user.referral_source || null;
          languageCode = user.lang || null;
          
          // Вычисляем текущий тарифный план пользователя
          const isPremium = user.premium_until && new Date(user.premium_until) > new Date();
          if (isPremium) {
            const limit = user.premium_limit;
            if (limit === null) userPlan = 'Unlimited';
            else if (limit >= 100) userPlan = 'Pro';
            else userPlan = 'Plus';
          } else {
            userPlan = 'Free';
          }
        }
        
        if (!languageCode) {
          languageCode = ctx.from?.language_code || null;
        }

        // Автоопределение event_source на основе типа апдейта
        if (ctx.inlineQuery) {
          eventSource = 'inline_query';
        } else if (ctx.callbackQuery) {
          eventSource = 'callback_query';
        } else if (ctx.message) {
          if (ctx.message.voice || ctx.message.video_note || ctx.message.audio || ctx.message.video) {
            eventSource = 'shazam';
          } else {
            eventSource = 'text_message';
          }
        }
      }

      const sql = `
        INSERT INTO public.analytics_events 
          (user_id, event_name, event_category, event_data, session_id, 
           event_origin, acquisition_source, event_source, placement, 
           campaign_id, language_code, deduplication_key)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;
      `;

      await query(sql, [
        userId,
        eventName,
        category,
        eventData ? JSON.stringify(eventData) : null,
        sessionId,
        'live', // Всегда 'live' для событий, собранных в реальном времени
        acquisitionSource,
        eventSource,
        placement,
        campaignId,
        languageCode,
        dedupKey
      ]);
    } catch (e) {
      console.error(`[Analytics] Ошибка записи события ${eventName}:`, e.message);
      throw e;
    }
  }

  /**
   * Безопасная запись аналитического события (ошибки логирования не ломают работу бота)
   */
  async trackEventSafe(userId, eventName, category, eventData = {}, ctx = null) {
    try {
      await this.trackEvent(userId, eventName, category, eventData, ctx);
    } catch (e) {
      // Игнорируем ошибку
    }
  }

  /**
   * Обрабатывает начало сессии и продуктовые возвраты пользователя (вызывается в middleware)
   */
  async handleSessionAndActivity(userId, user, ctx) {
    if (!userId || !user) return;
    
    try {
      const today = getMoscowDateString();
      const secondsToMidnight = getSecondsUntilMoscowMidnight();

      // --- 1. Проверка технической сессии (session_started) ---
      const sessionKey = `session:${userId}`;
      let hasSession = false;
      
      if (redisService.client && redisService.client.isOpen) {
        hasSession = await redisService.client.exists(sessionKey);
      }

      if (!hasSession) {
        // Запуск новой сессии
        await this.trackEventSafe(userId, 'session_started', 'user', {
          event_source: ctx ? (ctx.inlineQuery ? 'inline_query' : (ctx.callbackQuery ? 'callback_query' : 'text_message')) : 'direct'
        }, ctx);
      }

      // --- 2. Проверка продуктового возврата за день (user_returned_daily) ---
      const dailyKey = `daily_active:${userId}:${today}`;
      let hasDaily = false;
      
      if (redisService.client && redisService.client.isOpen) {
        hasDaily = await redisService.client.exists(dailyKey);
      }

      if (!hasDaily) {
        // Устанавливаем ключ до полуночи по МСК
        if (redisService.client && redisService.client.isOpen) {
          await redisService.client.set(dailyKey, 'true', { EX: secondsToMidnight });
        }
        
        await this.trackEventSafe(userId, 'user_returned_daily', 'user', {
          date: today
        }, ctx);
      }

      // --- 3. Проверка возврата после неактивности (user_returned_after_inactivity) ---
      // Считаем неактивным, если не пользовался ботом более 7 суток
      if (user.last_active) {
        const lastActiveTime = new Date(user.last_active).getTime();
        const diffDays = (Date.now() - lastActiveTime) / (1000 * 60 * 60 * 24);
        
        if (diffDays > 7.0) {
          await this.trackEventSafe(userId, 'user_returned_after_inactivity', 'user', {
            inactive_days: Math.floor(diffDays),
            previous_last_active: user.last_active
          }, ctx);
        }
      }
    } catch (e) {
      console.error('[Analytics] Error in handleSessionAndActivity:', e.message);
    }
  }
}

export const analyticsService = new AnalyticsService();
export default analyticsService;
