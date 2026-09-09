// services/searchManager.js (улучшенная версия)

import ytdl from 'youtube-dl-exec';
import crypto from 'crypto';
import { PROXY_URL } from '../config.js';
import { redactSecretsInText } from './logSanitizer.js';

async function ytdlWithFallback(url, flags) {
  try {
    return await ytdl(url, flags);
  } catch (err) {
    const errText = err.stderr || err.message || '';
    if (flags.proxy && (errText.includes('Unable to connect to proxy') || errText.includes('ProxyError') || errText.includes('Tunnel connection failed') || errText.includes('Failed to establish a new connection'))) {
      console.warn('[SearchManager] Прокси ([REDACTED]) недоступен. Пробую без прокси... Ошибка:', redactSecretsInText(errText).slice(0, 200));
      const flagsCopy = { ...flags };
      delete flagsCopy.proxy;
      return await ytdl(url, flagsCopy);
    }
    throw err;
  }
}
import { searchTracksInCache, logSearchQuery, logFailedSearch } from '../db.js';
import redisService from './redisClient.js';
import {
    formatInlineCachedAudioResults,
    isUsableInlineCachedTrack
} from './inlineCachedAudioResults.js';

// ========================= CONFIGURATION =========================

const SEARCH_TIMEOUT_MS = parseInt(process.env.SEARCH_TIMEOUT_MS, 10) || 8000;
const SEARCH_RESULTS_LIMIT = 7;
const CACHE_TTL = 3600; // 1 час

// Получаем юзернейм бота из переменной окружения или используем дефолт
const BOT_USERNAME = process.env.BOT_USERNAME || 'YourBotUsername';

// ========================= HELPER FUNCTIONS =========================

/**
 * Санитизация поискового запроса
 */
function sanitizeQuery(query) {
    if (!query || typeof query !== 'string') return '';
    return query.trim().slice(0, 100); // Максимум 100 символов
}

/**
 * Централизованное логирование для поиска
 */
function log(level, message) {
    const timestamp = new Date().toISOString();
    console.log(`[Search/${level}] ${timestamp} ${message}`);
}

// ========================= SEARCH FUNCTIONS =========================

/**
 * Живой поиск на SoundCloud через yt-dlp
 */
async function searchLiveOnSoundCloud(query, timeoutMs = SEARCH_TIMEOUT_MS) {
    log('INFO', `Выполняю живой поиск для: "${query}"`);
    
    try {
        // Создаем Promise с таймаутом
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('SEARCH_TIMEOUT')), timeoutMs)
        );
        
        // Запускаем поиск через yt-dlp
        const ytdlPromise = ytdlWithFallback(`scsearch${SEARCH_RESULTS_LIMIT}:${query}`, {
            dumpSingleJson: true,
            proxy: PROXY_URL || undefined,
            noWarnings: true
        });
        
        // Гонка между поиском и таймаутом
        const searchData = await Promise.race([ytdlPromise, timeoutPromise]);
        
        if (!searchData?.entries || searchData.entries.length === 0) {
            log('WARN', `Живой поиск не вернул результатов для "${query}"`);
            return [];
        }
        
        log('OK', `Живой поиск нашел ${searchData.entries.length} треков`);
        
        return searchData.entries.map(track => ({
            type: 'article',
            id: `live_${crypto.randomBytes(8).toString('hex')}`,
            title: track.title || 'Без названия',
            description: `by ${track.uploader || 'Unknown'} • ${track.duration_string || 'N/A'}`,
            thumb_url: track.thumbnail || 'https://i.imgur.com/8l4n5pG.png',
            input_message_content: {
                message_text: track.webpage_url
            }
        }));
    } catch (error) {
        if (error.message === 'SEARCH_TIMEOUT') {
            log('WARN', `Таймаут поиска (${timeoutMs}мс) для "${query}"`);
        } else {
            log('ERROR', `Ошибка живого поиска для "${query}": ${error.stderr || error.message}`);
        }
        return [];
    }
}

/**
 * Поиск в кэше БД с промежуточным Redis
 */
async function searchInCache(query) {
    const cacheKey = `search:${query.toLowerCase()}`;
    
    // Пробуем Redis
    try {
        const cached = await redisService.getJson(cacheKey);
        if (cached?.length > 0) {
            log('OK', `Redis cache hit для "${query}" (${cached.length} треков)`);
            return cached;
        }
    } catch (e) {
        log('WARN', `Redis недоступен для поиска: ${e.message}`);
    }
    
    // Fallback на БД
    const dbResults = await searchTracksInCache(query);
    
    if (dbResults?.length > 0) {
        // Кэшируем в Redis на будущее
        try {
            await redisService.setJson(cacheKey, dbResults, CACHE_TTL);
        } catch (e) {
            log('WARN', `Не удалось закэшировать в Redis: ${e.message}`);
        }
    }
    
    return dbResults || [];
}

// ========================= MAIN FUNCTION =========================

/**
 * Гибридный поиск: сначала кэш, потом живой поиск
 */
export async function performInlineSearch(query, userId, options = {}) {
    const liveTimeoutMs = Number(options.liveTimeoutMs) || SEARCH_TIMEOUT_MS;
    const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
    const skipCache = options.skipCache === true;
    // Санитизация
    query = sanitizeQuery(query);
    
    if (!query || query.length < 2) {
        log('WARN', 'Пустой или слишком короткий запрос');
        return [];
    }
    
    log('INFO', `Начинаю поиск для пользователя ${userId}: "${query}"`);
    
    let results = [];
    let foundInCache = false;
    
    // --- 1. Поиск в кэше ---
    const cachedTracks = skipCache ? [] : await searchInCache(query);
    const usableCachedTracks = cachedTracks.filter(isUsableInlineCachedTrack);

    if (usableCachedTracks.length !== cachedTracks.length) {
        log('WARN', `Пропущено некорректных cached audio: ${cachedTracks.length - usableCachedTracks.length}`);
    }
    
    if (usableCachedTracks.length > 0) {
        log('OK', `Найдено ${usableCachedTracks.length} треков в кэше`);
        results = usableCachedTracks;
        foundInCache = true;
    } else {
        // Inline handler can invalidate a request while Redis/DB is being checked.
        // Avoid starting an expensive yt-dlp process for an already superseded query.
        if (!isCurrent()) return [];
        // --- 2. Живой поиск ---
        log('INFO', skipCache
            ? 'Кэш отключён, выполняю живой поиск'
            : 'Кэш пуст, переключаюсь на живой поиск');
        results = await searchLiveOnSoundCloud(query, liveTimeoutMs);
        foundInCache = false;
    }
    
    // --- 3. Логирование ---
    await logSearchQuery({
        query,
        userId,
        resultsCount: results.length,
        foundInCache
    }).catch(e => log('ERROR', `Ошибка логирования: ${e.message}`));
    
    if (results.length === 0) {
        log('WARN', `Ничего не найдено для "${query}"`);
        await logFailedSearch({ query, searchType: 'inline' }).catch(() => {});
    }
    
// --- 4. Форматирование результата ---
if (foundInCache) {
  return formatInlineCachedAudioResults(results);
} else {
    return results;
}
}
// ========================= EXPORTS SUMMARY =========================
// Основной экспорт: performInlineSearch(query, userId)
// Выполняет гибридный поиск (кэш → живой поиск) и возвращает массив результатов

// ========================= CONFIGURATION TIPS =========================
// 
// Переменные окружения (опционально):
// - SEARCH_TIMEOUT_MS=8000 (таймаут живого поиска)
// - BOT_USERNAME=YourBotName (для caption в результатах)
