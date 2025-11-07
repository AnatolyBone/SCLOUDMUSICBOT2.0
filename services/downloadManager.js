// services/downloadManager.js (безопасная финальная версия для бесплатных тарифов)

import fetch from 'node-fetch';
import pMap from 'p-map';
import { STORAGE_CHANNEL_ID, CHANNEL_USERNAME, PROXY_URL } from '../config.js';
import { Markup } from 'telegraf';
import path from 'path';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs';
import scdl from 'soundcloud-downloader'; // Добавьте эту строку
import os from 'os';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import ytdl from 'youtube-dl-exec';

import { bot } from '../bot.js';
import { T } from '../config/texts.js';
import { TaskQueue } from '../lib/TaskQueue.js';
import * as db from '../db.js';
import { getSetting } from './settingsManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));

// ========================= CONFIGURATION =========================

const cacheDir = path.join(os.tmpdir(), 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

const YTDL_TIMEOUT = 120;
const MAX_FILE_SIZE_BYTES = 49 * 1024 * 1024; // 49 МБ (лимит Telegram)
const UNLIMITED_PLAYLIST_LIMIT = 100;
const FAKE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36';

// Для бесплатных тарифов Render.com: 2 одновременных загрузки (чтобы не превышать лимиты CPU/RAM)
const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10) || 2;

const FFMPEG_AVAILABLE =
  (!!ffmpegPath && fs.existsSync(ffmpegPath)) &&
  process.env.FFMPEG_AVAILABLE !== '0' &&
  process.env.FFMPEG_STATIC_SKIP_DOWNLOAD !== '1';

// services/downloadManager.js

const YTDL_COMMON = {
  'format': 'bestaudio[ext=mp3]/bestaudio[ext=opus]/bestaudio', // <--- ДОБАВЛЕНО!
  'ffmpeg-location': ffmpegPath || undefined,
  'user-agent': FAKE_USER_AGENT,
  proxy: PROXY_URL || undefined,
  retries: 3,
  'socket-timeout': YTDL_TIMEOUT,
  'no-warnings': true,
  'extractor-args': 'soundcloud:player_client_id=CLIENT_ID'
};

// ========================= HELPER FUNCTIONS =========================

/**
 * Очищает имя файла от недопустимых символов
 */
function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return 'track';
  return name.replace(/[<>:"/\\|?*]+/g, '').trim() || 'track';
}

/**
 * Очищает URL от параметров (utm, ref, si и т.д.)
 */
/**
 * Очищает URL от параметров (utm, ref, si и т.д.)
 */
function cleanUrl(url) {
  if (!url || typeof url !== 'string') return url;
  
  try {
    const parsed = new URL(url);
    
    // ========================================
    // ✅ ИСПРАВЛЕНО: НЕ трогаем короткие ссылки
    // ========================================
    
    // Короткие ссылки (on.soundcloud.com) НЕ трогаем - пусть yt-dlp сам их резолвит
    if (parsed.hostname === 'on.soundcloud.com') {
      return url; // Возвращаем как есть (с параметрами!)
    }
    
    // Для ПОЛНЫХ ссылок soundcloud.com убираем параметры
    if (parsed.hostname.includes('soundcloud.com')) {
      return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
    }
    
    // Для других URL возвращаем как есть
    return url;
  } catch (e) {
    // Если URL невалидный, возвращаем оригинал
    console.warn('[cleanUrl] Не удалось распарсить URL:', url, e.message);
    return url;
  }
}

async function resolveCanonicalUrl(url) {
  console.log(`[resolveUrl/Debug] 📥 Входящий URL: ${url}`);
  
  // 1. Сначала очищаем от параметров
  const cleanedUrl = cleanUrl(url);
  console.log(`[resolveUrl/Debug] 🧹 После cleanUrl: ${cleanedUrl}`);
  
  // 2. Если это уже полная ссылка — возвращаем как есть
  if (!cleanedUrl.includes('on.soundcloud.com')) {
    console.log(`[resolveUrl/Debug] ✅ Полная ссылка, возвращаю: ${cleanedUrl}`);
    return cleanedUrl;
  }
  
  try {
    console.log(`[resolveUrl] Резолвлю короткую ссылку: ${cleanedUrl}`);
    
    const info = await ytdl(cleanedUrl, {
      'dump-single-json': true,
      'no-playlist': true,
      ...YTDL_COMMON
    });
    
    console.log(`[resolveUrl/Debug] 📊 Получены метаданные:`, {
      webpage_url: info.webpage_url,
      url: info.url,
      id: info.id,
      title: info.title
    });
    
    const canonical = info.webpage_url || info.url || cleanedUrl;
    const cleaned = cleanUrl(canonical); // 3. Очищаем результат от параметров
    console.log(`[resolveUrl] Канонический URL: ${cleaned}`);
    return cleaned;
    
  } catch (e) {
    console.error('[resolveUrl] ❌ ОШИБКА резолва:', {
      url: cleanedUrl,
      error: e.message,
      stderr: e.stderr,
      code: e.code
    });
    console.warn('[resolveUrl] Использую оригинальный URL:', cleanedUrl);
    return cleanedUrl;
  }
}

/**
 * Генерирует уникальный ключ кеша для трека
 */
function getCacheKey(meta, fallbackUrl) {
  if (meta?.id) return `sc:${meta.id}`;
  return fallbackUrl || 'unknown';
}

/**
 * Безопасная отправка сообщения пользователю с автоматической деактивацией при блокировке
 */
async function safeSendMessage(userId, text, extra = {}) {
  try {
    return await bot.telegram.sendMessage(userId, text, extra);
  } catch (e) {
    if (e.response?.error_code === 403) {
      try { 
        await db.updateUserField(userId, 'active', false); 
      } catch (dbErr) {
        console.error(`[DB] Не удалось деактивировать пользователя ${userId}:`, dbErr.message);
      }
    }
    return null;
  }
}

/**
 * Проверяет, можно ли копировать MP3 без конвертации
 */
function canCopyMp3(ext, acodec) {
  if (!ext && !acodec) return false;
  return ext === 'mp3' || /mp3/i.test(acodec || '');
}

/**
 * Инкрементирует счётчик загрузок (с поддержкой транзакционной версии)
 */
async function incrementDownload(userId, trackTitle, fileId, cacheKey) {
  if (typeof db.incrementDownloadsAndLogPg === 'function') {
    return await db.incrementDownloadsAndLogPg(userId, trackTitle, fileId, cacheKey);
  }
  return await db.incrementDownloadsAndSaveTrack(userId, trackTitle, fileId, cacheKey);
}

/**
 * Получает данные пользователя (минимальный набор для проверки лимитов)
 */
async function getUserUsage(userId) {
  if (typeof db.getUserUsage === 'function') return await db.getUserUsage(userId);
  if (typeof db.getUserLite === 'function') return await db.getUserLite(userId);
  return await db.getUser(userId);
}

/**
 * Извлекает метаданные трека из ответа youtube-dl
 */
// <<< ИСПРАВЛЕННЫЙ КОД >>>
function extractMetadataFromInfo(info) {
  const e = Array.isArray(info?.entries) ? info.entries[0] : info;
  if (!e) return null;
  
  const ext = e.ext || e.requested_downloads?.[0]?.ext || null;
  const acodec = e.acodec || e.requested_downloads?.[0]?.acodec || null;
  const filesize = e.filesize || e.filesize_approx || e.requested_downloads?.[0]?.filesize || null;
  
  return {
    id: e.id,
    webpage_url: e.webpage_url, // <--- ВОТ ОНО, ИСПРАВЛЕНИЕ!
    title: sanitizeFilename(e.title || 'Unknown Title'),
    uploader: e.uploader || 'Unknown Artist',
    duration: e.duration,
    thumbnail: e.thumbnail,
    ext,
    acodec,
    filesize
  };
}
/**
 * Проверяет безопасность URL (защита от SSRF)
 */
function isSafeUrl(url) {
  try {
    const parsed = new URL(url);
    
    // Разрешаем только HTTP/HTTPS
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    
    // Блокируем localhost и внутренние IP
    const hostname = parsed.hostname.toLowerCase();
    const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254.169.254'];
    if (blockedHosts.includes(hostname)) return false;
    
    // Блокируем приватные подсети
    if (/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(hostname)) return false;
    
    return true;
  } catch {
    return false;
  }
}

/**
 * Получает размер файла через HEAD-запрос
 */
async function getFileSizeFromHead(url) {
  try {
    const res = await fetch(url, { 
      method: 'HEAD', 
      timeout: 5000,
      headers: { 'User-Agent': FAKE_USER_AGENT }
    });
    const contentLength = res.headers.get('content-length');
    return contentLength ? parseInt(contentLength, 10) : null;
  } catch (e) {
    return null;
  }
}

/**
 * Получает размер файла через Range-запрос (fallback для HEAD)
 */
async function getFileSizeFromRange(url) {
  try {
    const res = await fetch(url, { 
      method: 'GET', 
      headers: { 
        'Range': 'bytes=0-0',
        'User-Agent': FAKE_USER_AGENT
      },
      timeout: 5000 
    });
    
    const rangeHeader = res.headers.get('content-range');
    if (rangeHeader) {
      // Формат: "bytes 0-0/12345678"
      const match = rangeHeader.match(/\/(\d+)$/);
      if (match) return parseInt(match[1], 10);
    }
  } catch (e) {
    return null;
  }
  return null;
}

/**
 * Комплексная проверка размера файла ДО начала загрузки
 */
async function checkFileSize(url) {
  try {
    // 1. Получаем прямую ссылку на стрим
    let streamUrl = await ytdl(url, { 'get-url': true, ...YTDL_COMMON });
    
    // youtube-dl может вернуть массив ссылок
    if (Array.isArray(streamUrl)) streamUrl = streamUrl[0];
    
    if (!streamUrl || typeof streamUrl !== 'string') {
      return { ok: false, reason: 'NO_STREAM_URL' };
    }
    
    // 2. Валидация безопасности URL
    if (!isSafeUrl(streamUrl)) {
      console.warn('[Pre-flight] Небезопасный URL:', streamUrl);
      return { ok: false, reason: 'UNSAFE_URL' };
    }
    
    // 3. Пробуем получить размер через HEAD
    let size = await getFileSizeFromHead(streamUrl);
    
    // 4. Fallback на Range-запрос
    if (!size) {
      size = await getFileSizeFromRange(streamUrl);
    }
    
    // 5. Если размер неизвестен — разрешаем загрузку (проверим при скачивании)
    if (!size) {
      console.warn('[Pre-flight] Не удалось определить размер файла, продолжаю.');
      return { ok: true, reason: 'SIZE_UNKNOWN' };
    }
    
    // 6. Проверяем лимит
    if (size > MAX_FILE_SIZE_BYTES) {
      console.warn(`[Pre-flight] Файл слишком большой: ${(size / 1024 / 1024).toFixed(2)} МБ`);
      return { ok: false, reason: 'FILE_TOO_LARGE', size };
    }
    
    console.log(`[Pre-flight] Размер файла: ${(size / 1024 / 1024).toFixed(2)} МБ — OK`);
    return { ok: true, size };
    
  } catch (e) {
    console.warn('[Pre-flight] Ошибка проверки размера:', e.message);
    // В случае ошибки — разрешаем загрузку (может быть временная проблема сети)
    return { ok: true, reason: 'CHECK_FAILED' };
  }
}

/**
 * Восстанавливает метаданные задачи, если они отсутствуют
 */
async function ensureTaskMetadata(task) {
  let { metadata, cacheKey } = task;
  const url = task.url || task.originalUrl;

  if (!metadata) {
    if (!url) throw new Error('TASK_MISSING_URL');
    
    console.warn('[Worker] metadata отсутствует, получаю через youtube-dl для URL:', url);
    const info = await ytdl(url, { 'dump-single-json': true, ...YTDL_COMMON });
    const md = extractMetadataFromInfo(info);
    
    if (!md) throw new Error('META_MISSING');
    metadata = md;
  }

  if (!cacheKey) {
    cacheKey = getCacheKey(metadata, task.originalUrl || url);
  }

  return { 
    metadata, 
    cacheKey, 
    source: task.source || 'soundcloud', 
    url 
  };
}

/**
 * Периодическая очистка старых файлов из кеша (раз в час)
 */
function startCacheCleanup() {
  const cleanupInterval = setInterval(() => {
    fs.readdir(cacheDir, (err, files) => {
      if (err) {
        console.error('[Cache Cleanup] Ошибка чтения директории:', err.message);
        return;
      }
      
      const now = Date.now();
      let cleaned = 0;
      
      files.forEach(file => {
        const filePath = path.join(cacheDir, file);
        fs.stat(filePath, (err, stats) => {
          if (err) return;
          
          // Удаляем файлы старше 1 часа
          if (now - stats.mtimeMs > 3600000) {
            fs.unlink(filePath, (err) => {
              if (!err) cleaned++;
            });
          }
        });
      });
      
      if (cleaned > 0) {
        console.log(`[Cache Cleanup] Удалено ${cleaned} старых файлов из кеша.`);
      }
    });
  }, 3600000); // Раз в час
  
  // Graceful shutdown
  process.on('SIGTERM', () => clearInterval(cleanupInterval));
  process.on('SIGINT', () => clearInterval(cleanupInterval));
}

// Запускаем очистку при импорте модуля
startCacheCleanup();

// ========================= CORE WORKER =========================

/**
 * Основной воркер для обработки задачи загрузки трека
 */
// ========================= CORE WORKER (ОБНОВЛЕННАЯ БЫСТРАЯ ВЕРСИЯ) =========================

// =========================================================================
// =========================================================================
// =========================================================================
//        ФИНАЛЬНАЯ ИСПРАВЛЕННАЯ ВЕРСИЯ trackDownloadProcessor
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

    // `ensureTaskMetadata` вернет нам объект metadata с полной ссылкой
    const ensured = await ensureTaskMetadata(task);
    const { metadata, cacheKey } = ensured;
    
    // Проверяем, что metadata существует, прежде чем извлекать из него поля
    if (!metadata) {
      throw new Error('Не удалось получить метаданные для задачи.');
    }
    
    // Извлекаем поля из валидного объекта metadata
    const { title, uploader, duration, thumbnail, webpage_url: fullUrl } = metadata;
    const roundedDuration = duration ? Math.round(duration) : undefined;
    
    // Проверка наличия полной ссылки, необходимой для scdl
    if (!fullUrl || !fullUrl.includes('soundcloud.com')) {
      throw new Error(`Не удалось получить полную ссылку на трек из метаданных. Получено: ${fullUrl}`);
    }
    
    // Проверка кэша
    let cached = await db.findCachedTrack(cacheKey) || await db.findCachedTrack(fullUrl);
    if (cached?.fileId) {
      console.log(`[Worker/Cache] ХИТ! Отправляю "${cached.trackName || title}" из кэша.`);
      await bot.telegram.sendAudio(userId, cached.fileId, { title: cached.trackName, performer: cached.artist || uploader, duration: roundedDuration });
      await incrementDownload(userId, cached.trackName, cached.fileId, cacheKey);
      return;
    }

    statusMessage = await safeSendMessage(userId, `⏳ Начинаю обработку: "${title}"`);

    console.log(`[Worker/Stream] Открываю аудиопоток для: ${fullUrl}`);
    const stream = await scdl.download(fullUrl); // Используем полную ссылку

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
      const userStream = await scdl.download(fullUrl);
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
    // Надежный блок обработки ошибок
    const errorDetails = err?.stderr || err?.message || 'Неизвестная ошибка';
    // Безопасно получаем название трека через optional chaining
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
// ========================= DOWNLOAD QUEUE =========================

/**
 * Глобальная очередь загрузок с приоритетами
 * Для бесплатных тарифов: maxConcurrent = 2 (безопасно для Render.com)
 */
export const downloadQueue = new TaskQueue({
  maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
  taskProcessor: trackDownloadProcessor
});

console.log(`[DownloadManager] Очередь загрузок инициализирована (maxConcurrent: ${MAX_CONCURRENT_DOWNLOADS})`);

// ========================= ENQUEUE FUNCTION =========================

/**
 * Основная функция для постановки треков в очередь
 * Вызывается из bot.js при получении ссылки от пользователя
 */
// ========================= ENQUEUE FUNCTION =========================

// =========================================================================
//            ЗАМЕНИТЕ ВАШУ ФУНКЦИЮ ENQUEUE НА ЭТУ ПОЛНУЮ ВЕРСИЮ
// =========================================================================

export function enqueue(ctx, userId, url, earlyData = {}) {
  (async () => {
    let statusMessage = null;
    const startTime = Date.now();
    
    console.log(`[Enqueue/START] 🚀 Запуск для user ${userId}, URL: ${url}`);
    
    try {
     // <<< ПРАВИЛЬНЫЙ КОД >>>
if (earlyData.isSingleTrack && earlyData.metadata) {
    console.log('[Enqueue/FastPath] Использую готовые метаданные для одиночного трека.');
    
    // Проверяем лимит пользователя ПЕРЕД постановкой в очередь
    const user = await db.getUser(userId); // <--- ИСПРАВЛЕНО! Добавлен префикс "db."
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
    const cached = await db.findCachedTrack(metadata.webpage_url || url); // <--- ИСПРАВЛЕНО! Добавлен префикс "db."
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
// ========================= INITIALIZATION =========================

/**
 * Инициализация менеджера загрузок (для обратной совместимости)
 */
export function initializeDownloadManager() {
  console.log('[DownloadManager] Инициализация завершена.');
  console.log(`[DownloadManager] FFMPEG доступен: ${FFMPEG_AVAILABLE ? '✅' : '❌'}`);
  console.log(`[DownloadManager] Максимум одновременных загрузок: ${MAX_CONCURRENT_DOWNLOADS}`);
  console.log(`[DownloadManager] Канал-хранилище: ${STORAGE_CHANNEL_ID ? '✅ настроен' : '⚠️ не настроен'}`);
  console.log(`[DownloadManager] Автоочистка кэша: ✅ активна (каждые 60 мин)`);
}

// ========================= EXPORTS SUMMARY =========================
// Основные экспорты:
// - trackDownloadProcessor: воркер для обработки одной задачи
// - downloadQueue: глобальная очередь с приоритетами
// - enqueue: функция для добавления треков в очередь
// - initializeDownloadManager: инициализация (вызывается из index.js)

// Вспомогательные функции (не экспортируются):
// - sanitizeFilename, getCacheKey, safeSendMessage
// - canCopyMp3, extractMetadataFromInfo
// - isSafeUrl, checkFileSize (защита от SSRF и больших файлов)
// - ensureTaskMetadata, startCacheCleanup

// ========================= CONFIGURATION TIPS =========================
// 
// Для увеличения производительности (если сервер позволяет):
// Установи переменную окружения MAX_CONCURRENT_DOWNLOADS=3 или 4
// 
// Для экономии ресурсов на слабом сервере:
// Установи MAX_CONCURRENT_DOWNLOADS=1
// 
// Текущее значение оптимально для бесплатного тарифа Render.com
// 
// ========================= END OF FILE =========================