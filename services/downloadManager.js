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
import scdl from 'soundcloud-downloader';
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


export function enqueue(ctx, userId, url, earlyData = {}) {
    (async () => {
        let statusMessage = null;
        try {
            if (!url || typeof url !== 'string') {
                await safeSendMessage(userId, '❌ Некорректная ссылка.');
                return;
            }

            // <<< ИЗМЕНЕНИЕ №4: Упрощенная логика постановки в очередь >>>
            // `bot.js` уже проверил лимит и показал сообщение, здесь просто ставим в очередь

            const canonicalUrl = await resolveCanonicalUrl(url);

            // Проверяем кэш ДО постановки в очередь
            const cached = await db.findCachedTrack(url) || await db.findCachedTrack(canonicalUrl);
            if (cached?.fileId) {
                console.log(`[Enqueue] ⚡ КЭШ ХИТ! Мгновенная отправка: ${cached.trackName}`);
                await bot.telegram.sendAudio(userId, cached.fileId, { title: cached.trackName, performer: cached.artist });
                await incrementDownload(userId, cached.trackName, cached.fileId, url);
                return;
            }

            statusMessage = await safeSendMessage(userId, '🔍 Анализирую ссылку...');

            const info = await ytdl(canonicalUrl, { 'dump-single-json': true, ...YTDL_COMMON });
            const isPlaylist = Array.isArray(info.entries);

            const entries = isPlaylist ? info.entries : [info];
            if (entries.length === 0) throw new Error('Не найдено треков для обработки.');

            await bot.telegram.editMessageText(userId, statusMessage.message_id, undefined, '✅ Распознал. Добавляю в очередь...').catch(() => {});
            
            const user = await db.getUser(userId);
            const prio = user.premium_limit || 0;

            const tasks = entries.map(entry => {
                const metadata = extractMetadataFromInfo(entry);
                if (!metadata) return null;
                const realUrl = metadata.webpage_url || entry.url;
                return {
                    userId,
                    url: realUrl,
                    originalUrl: isPlaylist ? realUrl : url,
                    source: 'soundcloud',
                    metadata
                };
            }).filter(Boolean);

            for (const task of tasks) {
                downloadQueue.add({ ...task, priority: prio });
            }

            await safeSendMessage(userId, `⏳ Добавлено в очередь: ${tasks.length} трек(ов).`);
            if (statusMessage) {
                await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(()=>{});
            }

        } catch (err) {
            const errorMessage = err?.stderr || err?.message || 'Неизвестная ошибка';
            let userMessage = `❌ Ошибка при обработке ссылки.`;
            if (errorMessage.includes('HTTP Error 404')) userMessage = '❌ Трек не найден.';
            
            console.error(`[Enqueue] ❌ КРИТИЧЕСКАЯ ОШИБКА для ${userId}:`, errorMessage);
            
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