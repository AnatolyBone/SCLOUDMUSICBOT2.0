// services/analyticsService.js

import { query } from '../db.js';
import redisService from './redisClient.js';
import { randomUUID } from 'crypto';
import { getDownloadFinalDeduplicationKey } from './downloadFlowService.js';

export const PRICING_OPEN_REASONS = Object.freeze([
  'daily_limit',
  'manual_command',
  'menu_button',
  'limit_message',
  'referral_bonus_expired',
  'broadcast',
  'other'
]);

export function getDownloadFailureHttpStatus(error) {
  const candidates = [
    error?.response?.status,
    error?.status,
    error?.statusCode,
    String(error?.stderr || error?.message || error || '').match(/(?:HTTP(?: Error)?\s*)?(403|404|413)\b/i)?.[1]
  ];
  const status = candidates.map(Number).find(value => [403, 404, 413].includes(value));
  return status || null;
}

export function classifyDownloadFailure(error, details = {}) {
  const message = String(error?.stderr || error?.message || error || '').toLowerCase();
  const status = getDownloadFailureHttpStatus(error);
  if (status === 403) return 'http_403';
  if (status === 404) return 'http_404';
  if (status === 413) return 'http_413';
  if (/drm|preview_only|go\+|protected/.test(message)) return 'drm';
  if (/file_too_large|buffer_too_large|too large|50 mb|file exceeds/.test(message)) return 'file_too_large';
  if (/timeout|timed out|task_timeout|etimedout/.test(message)) return 'timeout';
  if (/queue|broker|redis|enqueue/.test(message)) return 'queue_failure';
  if (/unsupported|format is not available|no suitable format/.test(message)) return 'unsupported';
  if (details.stage === 'metadata') return 'metadata_failure';
  if (details.stage === 'upload' || details.stage === 'delivery') return 'upload_failure';
  return 'unknown';
}

export function buildDownloadFailureEventData(error, details = {}) {
  const correlationId = details.correlation_id || details.correlationId || null;
  return {
    source: details.source || 'unknown',
    path: details.path || 'direct_url',
    error_category: classifyDownloadFailure(error, details),
    http_status: getDownloadFailureHttpStatus(error),
    is_playlist: Boolean(details.is_playlist),
    stage: details.stage || 'download',
    correlation_id: correlationId,
    pricing_open_reason: null,
    deduplication_key: getDownloadFinalDeduplicationKey(correlationId)
  };
}

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
  async inferPricingOpenReason(userId, explicitReason = null) {
    if (PRICING_OPEN_REASONS.includes(explicitReason)) return explicitReason;
    if (!userId) return 'other';
    try {
      const recent = await query(
        `SELECT event_name
         FROM public.analytics_events
         WHERE user_id = $1
           AND created_at >= timezone('utc', now()) - interval '30 minutes'
           AND event_name = ANY($2::text[])
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [userId, [
          'daily_limit_reached', 'download_attempt_over_limit', 'playlist_limit_reached',
          'premium_feature_opened', 'referral_bonus_ended', 'subscription_notification_opened',
          'broadcast_received', 'broadcast_clicked'
        ]]
      );
      const eventName = recent.rows[0]?.event_name;
      if (eventName === 'daily_limit_reached' || eventName === 'download_attempt_over_limit') return 'daily_limit';
      if (eventName === 'referral_bonus_ended') return 'referral_bonus_expired';
      if (eventName === 'broadcast_received' || eventName === 'broadcast_clicked') return 'broadcast';
    } catch (error) {
      console.warn('[Analytics] Pricing reason inference failed:', error.message);
    }
    return 'other';
  }

  async trackDownloadFailureSafe(userId, error, details = {}, ctx = null) {
    if (!userId) return;
    await this.trackEventSafe(
      userId,
      'track_download_failed',
      'downloads',
      buildDownloadFailureEventData(error, details),
      ctx
    );
  }

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
            const code = user.tariff_code || (user.premium_limit === null ? 'unlimited' : Number(user.premium_limit) >= 100 ? 'pro' : 'plus');
            userPlan = ({ unlimited: 'Unlimited', pro: 'Pro', plus: 'Plus' })[code] || 'Plus';
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
      let safeEventData = eventData;
      if (eventName === 'track_download_success' || eventName === 'track_download_failed') {
        const correlationId = eventData?.correlation_id || eventData?.correlationId || null;
        const finalDeduplicationKey = getDownloadFinalDeduplicationKey(correlationId);
        if (finalDeduplicationKey) {
          safeEventData = { ...eventData, deduplication_key: finalDeduplicationKey };
        }
      }
      await this.trackEvent(userId, eventName, category, safeEventData, ctx);
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
