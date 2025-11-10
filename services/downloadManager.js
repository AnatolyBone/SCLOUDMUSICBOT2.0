// services/downloadManager.js - ОБНОВЛЕННАЯ ВЕРСИЯ С ПОДДЕРЖКОЙ SPOTIFY

import fetch from 'node-fetch';
import pMap from 'p-map';
import { STORAGE_CHANNEL_ID, CHANNEL_USERNAME, PROXY_URL } from '../config.js';
import { Readable } from 'stream';
import { Markup } from 'telegraf';
import path from 'path';
import ffmpegPath from 'ffmpeg-static';
import playdl from 'play-dl';
import fs from 'fs';
import scdl from 'soundcloud-downloader';
import os from 'os';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import ytdl from 'youtube-dl-exec';
import ytsr from 'ytsr'; // npm install ytsr
import ytdlCore from 'ytdl-core';
import { bot } from '../bot.js';
import { T } from '../config/texts.js';
import { TaskQueue } from '../lib/TaskQueue.js';
import * as db from '../db.js';
import { getSetting } from './settingsManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMP_DIR = path.join(os.tmpdir(), 'sc-cache');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10) || 2;
const YTDL_COMMON = {
  'format': 'bestaudio[ext=mp3]/bestaudio[ext=opus]/bestaudio',
  'ffmpeg-location': ffmpegPath,
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
  proxy: PROXY_URL,
  retries: 3,
  'socket-timeout': 120,
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
  } catch { return url; }
}

async function resolveCanonicalUrl(url) {
  const cleanedUrl = cleanUrl(url);
  if (!cleanedUrl.includes('on.soundcloud.com')) return cleanedUrl;
  try {
    const info = await ytdl(cleanedUrl, { 'dump-single-json': true, 'no-playlist': true, ...YTDL_COMMON });
    return cleanUrl(info.webpage_url || info.url || cleanedUrl);
  } catch (e) {
    console.error('[resolveUrl] Ошибка резолва:', e.message);
    return cleanedUrl;
  }
}

function getCacheKey(meta, fallbackUrl, source = 'soundcloud') {
  if (source === 'spotify' && meta?.id) return `spotify:${meta.id}`;
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

function extractMetadataFromInfo(info) {
  const e = Array.isArray(info?.entries) ? info.entries[0] : info;
  if (!e) return null;
  return {
    id: e.id,
    webpage_url: e.webpage_url,
    title: sanitizeFilename(e.title || 'Unknown Title'),
    uploader: e.uploader || 'Unknown Artist',
    duration: e.duration,
    thumbnail: e.thumbnail,
  };
}

async function ensureTaskMetadata(task) {
  let { metadata, cacheKey } = task;
  const url = task.url || task.originalUrl;
  const source = task.source || 'soundcloud';
  
  if (!metadata && source !== 'spotify') {
    if (!url) throw new Error('TASK_MISSING_URL');
    console.warn('[Worker] metadata отсутствует, получаю через ytdl для URL:', url);
    const info = await ytdl(url, { 'dump-single-json': true, ...YTDL_COMMON });
    metadata = extractMetadataFromInfo(info);
    if (!metadata) throw new Error('META_MISSING');
  }
  
  if (!cacheKey) {
    cacheKey = getCacheKey(metadata, task.originalUrl || url, source);
  }
  
  return { metadata, cacheKey, url };
}

// Упрощенная версия для Render.com - без файлов, только потоки


// Инициализация play-dl (добавьте после импортов)
async function initializePlayDl() {
  try {
    // Авторизация play-dl (опционально, но помогает с ограничениями)
    await playdl.setToken({
      youtube: {
        cookie: '' // Можно оставить пустым
      }
    });
    console.log('[PlayDL] Инициализирован');
  } catch (error) {
    console.log('[PlayDL] Работаем без авторизации');
  }
}

// Вызовите при старте
initializePlayDl();


async function downloadFromYouTube(searchQuery, metadata = null) {
  console.log(`[YouTube] Поиск: ${searchQuery}`);
  
  try {
    const cleanQuery = searchQuery.replace(/^ytsearch1?:/, '').replace(/"/g, '');
    const spotifyDuration = metadata?.duration;
    
    console.log(`[YouTube] Ищу: "${cleanQuery}"`);
    if (metadata) {
      console.log(`[YouTube] Метаданные: ${metadata.title} - ${metadata.uploader}`);
      if (spotifyDuration) {
        console.log(`[YouTube] Целевая длительность: ${spotifyDuration}s`);
      }
    }
    
    // Сначала получаем прямой URL на аудио
    const searchResults = await ytdl(`ytsearch5:${cleanQuery}`, {
      dumpSingleJson: true,
      flatPlaylist: true,
      getUrl: true, // Получаем только URL
      format: 'bestaudio',
      ...YTDL_COMMON
    });
    
    if (!searchResults || !searchResults.entries || searchResults.entries.length === 0) {
      throw new Error('Не найдено видео');
    }
    
    // Находим лучшее совпадение
    let bestMatch = searchResults.entries[0];
    if (spotifyDuration) {
      let bestDiff = Infinity;
      for (const entry of searchResults.entries) {
        const diff = Math.abs((entry.duration || 0) - spotifyDuration);
        if (diff < bestDiff) {
          bestMatch = entry;
          bestDiff = diff;
        }
        if (diff <= 5) break;
      }
    }
    
    console.log(`[YouTube] Выбрано: ${bestMatch.title}`);
    
    // Получаем прямой URL на аудио
    const audioUrl = bestMatch.url || bestMatch.webpage_url;
    console.log(`[YouTube] Получаю прямой URL потока...`);
    
    // Получаем прямой URL используя youtube-dl
    const urlInfo = await ytdl(audioUrl, {
      getUrl: true,
      format: 'bestaudio',
      dumpSingleJson: true,
      ...YTDL_COMMON
    });
    
    if (!urlInfo || !urlInfo.url) {
      throw new Error('Не удалось получить прямой URL');
    }
    
    console.log(`[YouTube] Получен прямой URL, создаю поток...`);
    
    // Загружаем по прямому URL
    const response = await fetch(urlInfo.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Range': 'bytes=0-' // Для поддержки стриминга
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    // Преобразуем web stream в Node.js stream
    const nodeStream = Readable.from(response.body);
    
    console.log(`[YouTube] Поток готов к передаче`);
    return nodeStream;
    
  } catch (error) {
    console.error(`[YouTube] Ошибка:`, error.message);
    throw new Error(`YouTube: ${error.message}`);
  }
}
// =====================================================================================
//                   ОБНОВЛЕННАЯ ВЕРСИЯ trackDownloadProcessor
// =====================================================================================

export async function trackDownloadProcessor(task) {
  let statusMessage = null;
  const userId = parseInt(task.userId, 10);
  const source = task.source || 'soundcloud';
  
  try {
    const usage = await getUserUsage(userId);
    if (!usage || usage.downloads_today >= usage.premium_limit) {
      await safeSendMessage(userId, T('limitReached'));
      return;
    }

    const ensured = await ensureTaskMetadata(task);
    const { metadata, cacheKey } = ensured;
    
    if (!metadata) { 
      throw new Error('Не удалось получить метаданные для задачи.'); 
    }
    
    const { title, uploader, duration, thumbnail } = metadata;
    const roundedDuration = duration ? Math.round(duration) : undefined;
    
    // Проверяем кэш
    let cached = await db.findCachedTrack(cacheKey);
    if (cached?.fileId) {
      console.log(`[Worker/Cache] ХИТ! Отправляю "${cached.trackName || title}" из кэша.`);
      await bot.telegram.sendAudio(userId, cached.fileId, { 
        title: cached.trackName || title, 
        performer: cached.artist || uploader, 
        duration: roundedDuration 
      });
      await incrementDownload(userId, cached.trackName || title, cached.fileId, cacheKey);
      return;
    }

    statusMessage = await safeSendMessage(userId, `⏳ Начинаю обработку: "${title}"`);

    let stream;
    
    // Выбираем метод загрузки в зависимости от источника
    // В trackDownloadProcessor обновите секцию для Spotify
if (source === 'spotify') {
  console.log(`[Worker/Spotify] Загружаю с YouTube для Spotify трека: ${title}`);
  
  try {
    // Передаем metadata для умного поиска
    stream = await downloadFromYouTube(task.url, metadata);
  } catch (error) {
    console.error(`[Worker/Spotify] Ошибка загрузки: ${error.message}`);
    
    // Если не удалось загрузить, отправляем альтернативные варианты
    const cleanQuery = task.url.replace(/^ytsearch1?:/, '').replace(/"/g, '');
    
    const message = `🎵 <b>${title}</b>\n` +
      `👤 <i>${uploader}</i>\n` +
      `⏱ ${duration ? `${Math.floor(duration/60)}:${String(duration%60).padStart(2,'0')}` : ''}\n\n` +
      `⚠️ <i>Не удалось загрузить автоматически.</i>\n` +
      `<i>Попробуйте альтернативные способы:</i>`;
    
    await bot.telegram.sendMessage(userId, message, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔍 Найти на YouTube', url: `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanQuery)}` }],
          [{ text: '🎵 YouTube Music', url: `https://music.youtube.com/search?q=${encodeURIComponent(cleanQuery)}` }],
          [{ text: '💿 Скачать через Y2Mate', url: `https://www.y2mate.com/youtube-mp3/${encodeURIComponent(cleanQuery)}` }]
        ]
      }
    });
    
    if (statusMessage) {
      await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
    }
    
    // Логируем как попытку
    await incrementDownload(userId, title, 'youtube_fallback', cacheKey);
    return;
  }
} else {
  // Для SoundCloud код остается без изменений
  const fullUrl = metadata.webpage_url || task.url;
  if (!fullUrl || !fullUrl.includes('soundcloud.com')) {
    throw new Error(`Не удалось получить полную ссылку на трек. Получено: ${fullUrl}`);
  }
  console.log(`[Worker/SoundCloud] Открываю аудиопоток для: ${fullUrl}`);
  stream = await scdl.default.download(fullUrl);
}
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
      // Сохраняем в кэш
      await db.cacheTrack({ 
        url: cacheKey, 
        fileId: finalFileId, 
        title, 
        artist: uploader, 
        duration: roundedDuration, 
        thumbnail,
        source 
      });
      console.log(`✅ [Cache] Трек "${title}" сохранён.`);
    }
    
    if (finalFileId) {
      await bot.telegram.sendAudio(userId, finalFileId, { 
        title, 
        performer: uploader, 
        duration: roundedDuration 
      });
    } else {
      console.warn('[Worker] Канал-хранилище не настроен. Отправляю напрямую...');
      // Для прямой отправки нужно создать новый поток
      let directStream;
      if (source === 'spotify') {
        directStream = await downloadFromYouTube(task.url);
      } else {
        const fullUrl = metadata.webpage_url || task.url;
        directStream = await scdl.default.download(fullUrl);
      }
      
      const sentMsg = await bot.telegram.sendAudio(
        userId, 
        { source: directStream }, 
        { title, performer: uploader, duration: roundedDuration }
      );
      finalFileId = sentMsg?.audio?.file_id;
    }

    if (statusMessage) {
      await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
    }
    
    if (finalFileId) {
      await incrementDownload(userId, title, finalFileId, cacheKey);
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

// Остальной код остается без изменений...
export const downloadQueue = new TaskQueue({
  maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
  taskProcessor: trackDownloadProcessor
});

console.log(`[DownloadManager] Очередь загрузок инициализирована (maxConcurrent: ${MAX_CONCURRENT_DOWNLOADS})`);

export function enqueue(ctx, userId, url, earlyData = {}) {
  // Ваша существующая функция enqueue остается без изменений
  (async () => {
    let statusMessage = null;
    const startTime = Date.now();
    
    console.log(`[Enqueue/START] 🚀 Запуск для user ${userId}, URL: ${url}`);
    
    try {
      if (earlyData.isSingleTrack && earlyData.metadata) {
        console.log('[Enqueue/FastPath] Использую готовые метаданные для одиночного трека.');
        
        const user = await db.getUser(userId);
        if ((user.downloads_today || 0) >= user.premium_limit) {
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
        if (!metadata) throw new Error('Не удалось извлечь метаданные из earlyData.');

        const { webpage_url: fullUrl, id } = metadata;
        const cacheKey = id ? `sc:${id}` : null;
        const cached = await db.findCachedTrack(url) || await db.findCachedTrack(fullUrl) || (cacheKey && await db.findCachedTrack(cacheKey));

        if (cached?.fileId) {
            console.log(`[Enqueue/FastPath] ⚡ КЭШ ХИТ! Отправляю "${cached.trackName}"`);
            await bot.telegram.sendAudio(userId, cached.fileId, { title: cached.trackName, performer: cached.artist });
            await incrementDownload(userId, cached.trackName, cached.fileId, url);
            return;
        }

        console.log('[Enqueue/FastPath] Кэш не найден. Ставлю задачу в очередь.');
        const task = { userId, url: fullUrl, originalUrl: url, source: 'soundcloud', cacheKey, metadata };
        downloadQueue.add({ ...task, priority: user.premium_limit || 5 });
        
        await safeSendMessage(userId, `✅ Трек "${metadata.title}" добавлен в очередь.`);
        return;
      }

      console.log('[Enqueue/Fallback] Запущена логика для плейлиста или старого вызова.');

    } catch (err) {
      const errorMessage = err?.stderr || err?.message || String(err);
      let userMessage = `❌ Ошибка при обработке ссылки.`;
      console.error(`[Enqueue] ❌ КРИТИЧЕСКАЯ ОШИБКА для ${userId}:`, { message: errorMessage, url: url });
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