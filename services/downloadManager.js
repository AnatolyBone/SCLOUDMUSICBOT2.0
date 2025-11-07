// =========================================================================
//            СКОПИРУЙТЕ ЭТОТ КОД И ПОЛНОСТЬЮ ЗАМЕНИТЕ ИМ
//                  ФАЙЛ services/downloadManager.js
// =========================================================================

import fetch from 'node-fetch';
import pMap from 'p-map';
import { STORAGE_CHANNEL_ID, CHANNEL_USERNAME, PROXY_URL } from '../config.js';
import { Markup } from 'telegraf';
import path from 'path';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import SoundCloud from 'soundcloud-downloader';
import ytdl from 'youtube-dl-exec';

import { bot } from '../bot.js';
import { T } from '../config/texts.js';
import { TaskQueue } from '../lib/TaskQueue.js';
import * as db from '../db.js';
import { getSetting } from './settingsManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));

const cacheDir = path.join(os.tmpdir(), 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

const YTDL_TIMEOUT = 120;
const FAKE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36';
const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10) || 2;

const YTDL_COMMON = {
  'ffmpeg-location': ffmpegPath || undefined,
  'user-agent': FAKE_USER_AGENT,
  proxy: PROXY_URL || undefined,
  retries: 3,
  'socket-timeout': YTDL_TIMEOUT,
  'no-warnings': true,
  'extractor-args': 'soundcloud:player_client_id=CLIENT_ID'
};

function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return 'track';
  return name.replace(/[<>:"/\\|?*]+/g, '').trim() || 'track';
}

function cleanUrl(url) {
  if (!url || typeof url !== 'string') return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'on.soundcloud.com') return url;
    if (parsed.hostname.includes('soundcloud.com')) return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
    return url;
  } catch (e) {
    return url;
  }
}

async function resolveCanonicalUrl(url) {
  const cleanedUrl = cleanUrl(url);
  if (!cleanedUrl.includes('on.soundcloud.com')) return cleanedUrl;
  
  try {
    const info = await ytdl(cleanedUrl, { 'dump-single-json': true, 'no-playlist': true, ...YTDL_COMMON });
    const canonical = info.webpage_url || info.url || cleanedUrl;
    return cleanUrl(canonical);
  } catch (e) {
    console.error('[resolveUrl] ❌ ОШИБКА резолва:', e.message);
    return cleanedUrl;
  }
}

function getCacheKey(meta, fallbackUrl) {
  if (meta?.id) return `sc:${meta.id}`;
  return fallbackUrl || 'unknown';
}

async function safeSendMessage(userId, text, extra = {}) {
  try {
    return await bot.telegram.sendMessage(userId, text, extra);
  } catch (e) {
    if (e.response?.error_code === 403) {
      await db.updateUserField(userId, 'active', false).catch(dbErr => console.error(`[DB] Не удалось деактивировать ${userId}:`, dbErr.message));
    }
    return null;
  }
}

async function incrementDownload(userId, trackTitle, fileId, cacheKey) {
    return await db.incrementDownloadsAndSaveTrack(userId, trackTitle, fileId, cacheKey);
}

async function getUserUsage(userId) {
    return await db.getUser(userId);
}

// <<< ИЗМЕНЕНИЕ №2: Убеждаемся, что функция extractMetadataFromInfo передает webpage_url >>>
function extractMetadataFromInfo(info) {
  const e = Array.isArray(info?.entries) ? info.entries[0] : info;
  if (!e) return null;
  return {
    id: e.id,
    webpage_url: e.webpage_url, // <-- ЭТО КЛЮЧЕВАЯ СТРОКА
    title: sanitizeFilename(e.title || 'Unknown Title'),
    uploader: e.uploader || 'Unknown Artist',
    duration: e.duration,
    thumbnail: e.thumbnail,
    ext: e.ext,
    acodec: e.acodec,
    filesize: e.filesize || e.filesize_approx,
  };
}

async function ensureTaskMetadata(task) {
  let { metadata, cacheKey } = task;
  const url = task.url || task.originalUrl;

  if (!metadata) {
    if (!url) throw new Error('TASK_MISSING_URL');
    console.warn('[Worker] metadata отсутствует, получаю через ytdl для URL:', url);
    const info = await ytdl(url, { 'dump-single-json': true, ...YTDL_COMMON });
    metadata = extractMetadataFromInfo(info);
    if (!metadata) throw new Error('META_MISSING');
  }

  if (!cacheKey) {
    cacheKey = getCacheKey(metadata, task.originalUrl || url);
  }

  return { metadata, cacheKey, url };
}

// <<< ИЗМЕНЕНИЕ №3: ФИНАЛЬНЫЙ КОД ВОРКЕРА, ИСПОЛЬЗУЮЩИЙ `soundcloud-downloader` >>>
// =========================================================================
//        ФИНАЛЬНАЯ ВЕРСИЯ trackDownloadProcessor (С ПРАВИЛЬНЫМ ИМПОРТОМ)
// =========================================================================

// =========================================================================
//        ФИНАЛЬНАЯ ВЕРСИЯ trackDownloadProcessor (С ПРАВИЛЬНЫМ ВЫЗОВОМ)
// =========================================================================

export async function trackDownloadProcessor(task) {
  let statusMessage = null;
  const userId = parseInt(task.userId, 10);
  
  try {
    const usage = await getUserUsage(userId);
    if (!usage || usage.downloads_today >= usage.premium_limit) {
      await safeSendMessage(userId, T('limitReached'));
      return;
    }

    const ensured = await ensureTaskMetadata(task);
    const { metadata, cacheKey } = ensured;
    
    if (!metadata) { throw new Error('Не удалось получить метаданные для задачи.'); }
    
    const { title, uploader, duration, thumbnail, webpage_url: fullUrl } = metadata;
    const roundedDuration = duration ? Math.round(duration) : undefined;
    
    if (!fullUrl || !fullUrl.includes('soundcloud.com')) {
      throw new Error(`Не удалось получить полную ссылку на трек из метаданных. Получено: ${fullUrl}`);
    }
    
    let cached = await db.findCachedTrack(cacheKey) || await db.findCachedTrack(fullUrl);
    if (cached?.fileId) {
      console.log(`[Worker/Cache] ХИТ! Отправляю "${cached.trackName || title}" из кэша.`);
      await bot.telegram.sendAudio(userId, cached.fileId, { title: cached.trackName, performer: cached.artist || uploader, duration: roundedDuration });
      await incrementDownload(userId, cached.trackName, cached.fileId, cacheKey);
      return;
    }

    statusMessage = await safeSendMessage(userId, `⏳ Начинаю обработку: "${title}"`);

    console.log(`[Worker/Stream] Открываю аудиопоток для: ${fullUrl}`);
    // <<< ИСПРАВЛЕНИЕ ЗДЕСЬ >>>
    const stream = await scdl.default.download(fullUrl);

    let finalFileId = null;

    if (STORAGE_CHANNEL_ID) {
      try {
        console.log(`[Worker/Stream] Передаю поток в канал-хранилище...`);
        const sentToStorage = await bot.telegram.sendAudio(
          STORAGE_CHANNEL_ID,
          { source: stream },
          { title, performer: uploader, duration: roundedDuration }
        );
        finalFileId = sentToStorage?.audio?.file_id;
        console.log(`[Worker/Stream] ✅ Успешно. file_id получен.`);
      } catch (e) {
        console.error(`❌ Ошибка при отправке потока в хранилище:`, e.message);
        throw e;
      }
    }

    if (finalFileId) {
        const urlAliases = [];
        if (task.originalUrl && task.originalUrl !== fullUrl && task.originalUrl.includes('soundcloud.com')) { urlAliases.push(task.originalUrl); }
        if (cacheKey && !cacheKey.startsWith('http')) { urlAliases.push(cacheKey); }
        if (fullUrl && fullUrl.includes('soundcloud.com')) {
          await db.cacheTrack({ url: fullUrl, fileId: finalFileId, title, artist: uploader, duration: roundedDuration, thumbnail, aliases: urlAliases });
          console.log(`✅ [Cache] Трек "${title}" сохранён.`);
        }
    }
    
    if (finalFileId) {
      await bot.telegram.sendAudio(userId, finalFileId, { title, performer: uploader, duration: roundedDuration });
    } else {
      console.warn('[Worker] Канал-хранилище не настроен. Повторно открываю поток...');
      // <<< ИСПРАВЛЕНИЕ И ЗДЕСЬ >>>
      const userStream = await scdl.default.download(fullUrl);
      const sentMsg = await bot.telegram.sendAudio(userId, { source: userStream }, { title, performer: uploader, duration: roundedDuration });
      finalFileId = sentMsg?.audio?.file_id;
    }

    if (statusMessage) {
      await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
    }
    
    if (finalFileId) {
      await incrementDownload(userId, title, finalFileId, task.originalUrl || fullUrl);
    }

  } catch (err) {
    const errorDetails = err?.stderr || err?.message || 'Неизвестная ошибка';
    const trackTitle = task?.metadata?.title ? `: "${task.metadata.title}"` : '';
    let userMsg = `❌ Не удалось обработать трек${trackTitle}`;
    
    console.error(`❌ Ошибка воркера для user ${userId}:`, errorDetails);
    
    if (statusMessage) {
      await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, userMsg).catch(() => {});
    } else {
      await safeSendMessage(userId, userMsg);
    }
  }
}

export const downloadQueue = new TaskQueue({
  maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
  taskProcessor: trackDownloadProcessor
});

console.log(`[DownloadManager] Очередь загрузок инициализирована (maxConcurrent: ${MAX_CONCURRENT_DOWNLOADS})`);


// =========================================================================
//            ЗАМЕНИТЕ ВАШУ ФУНКЦИЮ // =========================================================================
//            ЗАМЕНИТЕ ВАШУ ФУНКЦИЮ ENQUEUE НА ЭТУ ПОЛНУЮ ВЕРСИЮ
// =========================================================================

export function enqueue(ctx, userId, url, earlyData = {}) {
  (async () => {
    let statusMessage = null;
    const startTime = Date.now();
    
    console.log(`[Enqueue/START] 🚀 Запуск для user ${userId}, URL: ${url}`);
    
    try {
      // <<< НОВЫЙ БЛОК: "БЫСТРЫЙ ПУТЬ" ДЛЯ ОДИНОЧНЫХ ТРЕКОВ >>>
      if (earlyData.isSingleTrack && earlyData.metadata) {
        console.log('[Enqueue/FastPath] Использую готовые метаданные для одиночного трека.');
        
        // Проверяем лимит пользователя ПЕРЕД постановкой в очередь
        const user = await db.getUser(userId);
        if ((user.downloads_today || 0) >= (user.premium_limit || 0)) {
            console.log(`[Enqueue/FastPath] ⛔ Лимит для user ${userId} исчерпан. Отмена.`);
            // Отправляем сообщение с бонусом, если он доступен
            const bonusAvailable = Boolean(CHANNEL_USERNAME && !user?.subscribed_bonus_used);
            const cleanUsername = CHANNEL_USERNAME?.replace('@', '');
            const bonusText = bonusAvailable ? `\n\n🎁 Доступен бонус! Подпишись на <a href="https://t.me/${cleanUsername}">@${cleanUsername}</a> и получи <b>7 дней тарифа Plus</b>.` : '';
            const text = `${T('limitReached')}${bonusText}`;
            const extra = { parse_mode: 'HTML', disable_web_page_preview: true };
            if (bonusAvailable) {
              extra.reply_markup = { inline_keyboard: [[Markup.button.callback('✅ Я подписался, забрать бонус', 'check_subscription')]] };
            }
            await safeSendMessage(userId, text, extra);
            return;
        }

        const metadata = extractMetadataFromInfo(earlyData.metadata);
        // Извлекаем stream_url, который уже был получен в bot.js!
        const streamUrl = earlyData.metadata.url; 

        if (!metadata || !streamUrl) {
          throw new Error('Не удалось извлечь метаданные или stream_url из earlyData.');
        }

        // Даже на быстром пути проверим кэш, вдруг трек уже скачан
        const cached = await db.findCachedTrack(metadata.webpage_url || url);
        if (cached?.fileId) {
            console.log(`[Enqueue/FastPath] ⚡ FAST CACHE HIT! Мгновенная отправка: ${cached.trackName}`);
            await bot.telegram.sendAudio(userId, cached.fileId, { title: cached.trackName, performer: cached.artist });
            await incrementDownload(userId, cached.trackName, cached.fileId, metadata.webpage_url || url);
            return;
        }

        console.log('[Enqueue/FastPath] Кэш не найден. Ставлю задачу в очередь с готовой stream_url.');
        
        const task = {
          userId,
          url: metadata.webpage_url || url,
          originalUrl: url,
          source: 'soundcloud',
          cacheKey: getCacheKey(metadata, url),
          metadata: metadata,
          stream_url: streamUrl // <--- ПЕРЕДАЕМ ГОТОВУЮ ССЫЛКУ В ЗАДАЧУ!
        };

        const priority = user.premium_limit || 5;
        downloadQueue.add({ ...task, priority });
        
        await safeSendMessage(userId, `✅ Трек "${metadata.title}" добавлен в очередь.`);
        return; // ВЫХОДИМ, чтобы не выполнять медленную логику ниже
      }
      // <<< КОНЕЦ НОВОГО БЛОКА >>>


      // =========================================================================
      // ВЕСЬ ВАШ СТАРЫЙ КОД НИЖЕ ТЕПЕРЬ ЯВЛЯЕТСЯ "МЕДЛЕННЫМ ПУТЕМ"
      // Он будет выполняться только для плейлистов или если что-то пошло не так
      // =========================================================================

      // === 1. Валидация ===
      if (!url || typeof url !== 'string') {
        console.error('[Enqueue/Fallback] ❌ Некорректный URL:', url);
        await safeSendMessage(userId, '❌ Некорректная ссылка.');
        return;
      }
      
      console.log(`[Enqueue/Fallback] ✅ URL валиден: ${url}`);
      
      if (url.includes('spotify.com')) {
        await safeSendMessage(userId, '🛠 Скачивание из Spotify временно недоступно.');
        return;
      }
      
      // === 2. Ранняя проверка кэша ===
      console.log(`[Enqueue/Fallback] 🔗 Начинаю резолв URL...`);
      const originalShortUrl = url;
      console.log(`[Enqueue/Fallback/Debug] 🔍 Проверяю кэш для короткой ссылки: ${url}`);
      const quickCached = await db.findCachedTrack(url);
      
      if (quickCached?.fileId) {
        console.log(`[Enqueue/Fallback] [⚡ ULTRA FAST HIT] Нашёл по короткой ссылке: ${quickCached.trackName}`);
        try {
          await bot.telegram.sendAudio(userId, quickCached.fileId, { title: quickCached.trackName, performer: quickCached.artist || 'Unknown Artist', duration: quickCached.duration });
          await incrementDownload(userId, quickCached.trackName, quickCached.fileId, url);
          return;
        } catch (sendErr) {
          if (sendErr?.description?.includes('file_id')) { await db.deleteCachedTrack(url); } 
          else { throw sendErr; }
        }
      }
      
      // === 3. Резолв URL ===
      console.log(`[Enqueue/Fallback] Короткая ссылка не в кэше, резолвлю...`);
      const canonicalUrl = await resolveCanonicalUrl(url);
      console.log(`[Enqueue/Fallback] ✅ Резолв завершён: ${canonicalUrl}`);
      
      // === 4. Проверка кэша по каноническому URL ===
      const canonicalCached = await db.findCachedTrack(canonicalUrl);
      if (canonicalCached?.fileId) {
        console.log(`[Enqueue/Fallback] [⚡ FAST CACHE HIT] Мгновенная отправка: ${canonicalCached.trackName}`);
        try {
          await bot.telegram.sendAudio(userId, canonicalCached.fileId, { title: canonicalCached.trackName, performer: canonicalCached.artist || 'Unknown Artist', duration: canonicalCached.duration });
          await incrementDownload(userId, canonicalCached.trackName, canonicalCached.fileId, canonicalUrl);
          return;
        } catch (sendErr) {
          if (sendErr?.description?.includes('file_id')) { await db.deleteCachedTrack(canonicalUrl); } 
          else { throw sendErr; }
        }
      }
      
      url = canonicalUrl;
      
      // === 5. Проверка кэша по метаданным ===
      let earlyInfo;
      try { earlyInfo = await ytdl(canonicalUrl, { 'dump-single-json': true, 'no-playlist': true, ...YTDL_COMMON }); } 
      catch (metaErr) { console.warn('[Enqueue/Fallback] Не удалось получить метаданные для кэша:', metaErr.message); }
      
      if (earlyInfo && typeof db.findCachedTrackByMeta === 'function') {
        const earlyMeta = extractMetadataFromInfo(earlyInfo);
        if (earlyMeta) {
          const metaCached = await db.findCachedTrackByMeta({ title: earlyMeta.title, artist: earlyMeta.uploader, duration: Math.round(earlyMeta.duration) });
          if (metaCached?.fileId) {
            console.log(`[Enqueue/Fallback] [⚡ META CACHE HIT] ${metaCached.trackName}`);
            try {
              await bot.telegram.sendAudio(userId, metaCached.fileId, { title: metaCached.trackName, performer: metaCached.artist || 'Unknown Artist', duration: Math.round(earlyMeta.duration) });
              await incrementDownload(userId, metaCached.trackName, metaCached.fileId, canonicalUrl);
              return;
            } catch (sendErr) {
              if (sendErr.response?.error_code === 400) { await db.deleteCachedTrack(metaCached.url); }
            }
          }
        }
      }
      
      // === 6. ПРОДОЛЖАЕМ ОБЫЧНУЮ ЛОГИКУ ===
      console.log('[Enqueue/Fallback] 🔄 Начинаю обычную логику скачивания (для плейлиста)...');
      await db.resetDailyLimitIfNeeded(userId);
      const fullUser = await db.getUser(userId);
      const downloadsToday = Number(fullUser?.downloads_today || 0);
      const dailyLimit = Number(fullUser?.premium_limit || 0);
      
      if (downloadsToday >= dailyLimit) {
        const bonusAvailable = Boolean(CHANNEL_USERNAME && !fullUser?.subscribed_bonus_used);
        const cleanUsername = CHANNEL_USERNAME?.replace('@', '');
        const bonusText = bonusAvailable ? `\n\n🎁 Доступен бонус! Подпишись на <a href="https://t.me/${cleanUsername}">@${cleanUsername}</a> и получи <b>7 дней тарифа Plus</b>.` : '';
        const text = `${T('limitReached')}${bonusText}`;
        const extra = { parse_mode: 'HTML', disable_web_page_preview: true };
        if (bonusAvailable) {
          extra.reply_markup = { inline_keyboard: [[Markup.button.callback('✅ Я подписался, забрать бонус', 'check_subscription')]] };
        }
        await safeSendMessage(userId, text, extra);
        return;
      }
      
      statusMessage = await safeSendMessage(userId, '🔍 Анализирую ссылку...');
      const limits = { free: parseInt(getSetting('playlist_limit_free'), 10) || 10, plus: parseInt(getSetting('playlist_limit_plus'), 10) || 30, pro: parseInt(getSetting('playlist_limit_pro'), 10) || 100, unlim: parseInt(getSetting('playlist_limit_unlim'), 10) || 200 };
      let pLimit = limits.free;
      if (dailyLimit >= 10000) pLimit = limits.unlim;
      else if (dailyLimit >= 100) pLimit = limits.pro;
      else if (dailyLimit >= 30) pLimit = limits.plus;
      const pEnd = Math.min(Math.max(0, dailyLimit - downloadsToday), pLimit);

      let info;
      try {
        info = await ytdl(url, { 'dump-single-json': true, 'playlist-end': pEnd + 1, ...YTDL_COMMON });
      } catch (ytdlError) {
        throw new Error('Не удалось получить метаданные.');
      }
      if (!info) {
        throw new Error('Не удалось получить метаданные.');
      }

      const isPlaylist = Array.isArray(info.entries);
      const entries = isPlaylist ? info.entries : [info];
      
      if (isPlaylist && entries.length > pEnd) {
        await safeSendMessage(userId, `ℹ️ С учетом вашего тарифа будет обработано до <b>${pEnd}</b> треков из плейлиста.`, { parse_mode: 'HTML' });
      }
      
      let tracksToProcess = entries.slice(0, pEnd).map(e => {
        const md = extractMetadataFromInfo(e);
        if (!md) return null;
        const realUrl = e.webpage_url || e.url;
        const key = getCacheKey(md, realUrl);
        const trackOriginalUrl = isPlaylist ? realUrl : originalShortUrl;
        return { url: realUrl, originalUrl: trackOriginalUrl, source: 'soundcloud', cacheKey: key, metadata: md };
      }).filter(Boolean);

      if (tracksToProcess.length === 0) {
        throw new Error('Не удалось найти треки для загрузки.');
      }
      
      if (statusMessage) {
        await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, '🔄 Проверяю наличие треков...').catch(() => {});
      }

      const keyPairs = tracksToProcess.map(t => ({ track: t, primary: t.cacheKey, legacy: t.originalUrl }));
      const uniqueKeys = Array.from(new Set(keyPairs.flatMap(k => [k.primary, k.legacy].filter(Boolean))));
      const cacheMap = typeof db.findCachedTracks === 'function' ? await db.findCachedTracks(uniqueKeys) : new Map();
      
      let remaining = Math.max(0, dailyLimit - downloadsToday);
      const tasksToDownload = [];
      const cachedToSend = [];

      for (const pair of keyPairs) {
        if (remaining <= 0) break;
        const cached = cacheMap.get(pair.primary) || cacheMap.get(pair.legacy);
        if (cached) { cachedToSend.push({ track: pair.track, cached }); } 
        else { tasksToDownload.push(pair.track); }
      }
      
      let sentFromCacheCount = 0;
      await pMap(cachedToSend, async ({ track, cached }) => {
        if (remaining <= 0) return;
        try {
          await bot.telegram.sendAudio(userId, cached.fileId, { title: cached.trackName || track.metadata.title, performer: cached.artist || track.metadata.uploader, duration: track.metadata.duration });
          const ok = await incrementDownload(userId, cached.trackName || track.metadata.title, cached.fileId, track.cacheKey);
          if (ok !== null) { remaining--; sentFromCacheCount++; }
        } catch (err) {
          if (err?.description?.includes('FILE_REFERENCE_EXPIRED') || err?.description?.includes('file_id')) { tasksToDownload.push(track); } 
          else { console.error(`⚠️ Ошибка отправки из кэша:`, err.message); }
        }
      }, { concurrency: 3 });

      let finalMessage = '';
      if (tasksToDownload.length > 0 && remaining > 0) {
        const tasksToReallyDownload = tasksToDownload.slice(0, remaining);
        const prio = fullUser.premium_limit || 0;
        for (const task of tasksToReallyDownload) {
          downloadQueue.add({ userId, ...task, priority: prio });
        }
        finalMessage += `⏳ ${tasksToReallyDownload.length} трек(ов) в очереди.\n`;
      } else if (tasksToDownload.length > 0 && remaining <= 0) {
        finalMessage += `\n🚫 Лимит исчерпан.`;
      }
      
      if (finalMessage.trim() === '' && sentFromCacheCount > 0) {
        finalMessage = `✅ ${sentFromCacheCount} трек(ов) отправлено из кэша.`;
      } else if (finalMessage.trim() === '' && sentFromCacheCount === 0) {
        return; // Ничего не делали, ничего не говорим
      }

      if (statusMessage) {
        await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, finalMessage.trim()).catch(() => {});
      } else if (finalMessage.trim()) {
        await safeSendMessage(userId, finalMessage.trim());
      }

    } catch (err) {
      const errorMessage = err?.stderr || err?.message || String(err);
      let userMessage = `❌ Ошибка при обработке ссылки.`;
      if (errorMessage.includes('timed out')) userMessage = '❌ Превышено время ожидания.';
      else if (errorMessage.includes('HTTP Error 404')) userMessage = '❌ Трек не найден.';
      else if (errorMessage.includes('HTTP Error 403')) userMessage = '❌ Доступ ограничен.';
      
      console.error(`[Enqueue] ❌ КРИТИЧЕСКАЯ ОШИБКА для ${userId}:`, { message: errorMessage, stack: err?.stack, url: url });
      
      if (statusMessage) {
        await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, userMessage).catch(() => {});
      } else {
        await safeSendMessage(userId, userMessage);
      }
    }
  })().catch(err => {
    console.error('[Enqueue] ❌ ASYNC WRAPPER ERROR:', err);
  });
}
        

export function initializeDownloadManager() {
  console.log('[DownloadManager] Инициализация завершена.');
}