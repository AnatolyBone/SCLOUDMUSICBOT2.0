// =====================================================================================
//      DOWNLOAD MANAGER - ОПТИМИЗИРОВАН ДЛЯ RENDER FREE TIER
//      Приоритет: потоковая отправка (быстро, без записи на диск)
// =====================================================================================

import fs from 'fs';
import path from 'path';
import { STORAGE_CHANNEL_ID, CHANNEL_USERNAME, PROXY_URL, SPOTIPY_CLIENT_ID, SPOTIPY_CLIENT_SECRET } from '../config.js';

const COOKIES_PATH = path.join(process.cwd(), 'youtube_cookies.txt');

// Добавим проверку при загрузке модуля
if (fs.existsSync(COOKIES_PATH)) {
    console.log('🍪 [Cookies] Файл найден по пути:', COOKIES_PATH);
} else {
    console.log('🍪 [Cookies] Файл НЕ найден. Ожидался по пути:', COOKIES_PATH);
}
import { Markup } from 'telegraf';
import path from 'path';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs';
import scdl from 'soundcloud-downloader';
import os from 'os';
import { fileURLToPath } from 'url';
import ytdl from 'youtube-dl-exec';
import axios from 'axios';

import { bot } from '../bot.js';
import { T } from '../config/texts.js';
import { TaskQueue } from '../lib/TaskQueue.js';
import * as db from '../db.js';

// Папка для обложек
const THUMB_DIR = path.join(os.tmpdir(), 'sc-thumbs');
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

/**
 * Скачивает обложку и возвращает путь к файлу или null
 */
async function downloadThumbnail(thumbnailUrl) {
  if (!thumbnailUrl) return null;
  try {
    const thumbPath = path.join(THUMB_DIR, `thumb_${Date.now()}.jpg`);
    const response = await axios.get(thumbnailUrl, { responseType: 'arraybuffer', timeout: 10000 });
    fs.writeFileSync(thumbPath, response.data);
    return thumbPath;
  } catch (e) {
    console.warn('[Thumbnail] Не удалось скачать обложку:', e.message);
    return null;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Папка для временных файлов (нужна для yt-dlp fallback)
const TEMP_DIR = path.join(os.tmpdir(), 'sc-cache');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10) || 2;

// Настройки для yt-dlp
const YTDL_COMMON = {
  'format': 'bestaudio[ext=mp3]/bestaudio[ext=opus]/bestaudio',
  'ffmpeg-location': ffmpegPath,
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
  proxy: PROXY_URL,
  retries: 3,
  'socket-timeout': 120,
  'no-warnings': true,
};

// Базовые опции для получения метаданных/скачиваний через yt-dlp
const YTDL_OPTIONS = {
  ...YTDL_COMMON,
  'no-playlist': true,
  'ignore-errors': true
};

// ========================= QUALITY PRESETS =========================

export const QUALITY_PRESETS = {
  low: { bitrate: '128K', format: 'mp3', label: '128 kbps' },
  medium: { bitrate: '192K', format: 'mp3', label: '192 kbps' },
  high: { bitrate: '320K', format: 'mp3', label: '320 kbps' }
};

/**
 * Скачивает трек через spotdl (для Spotify)
 */
async function downloadWithSpotdl(url, quality = 'high') {
  const { spawn } = await import('child_process');
  const baseName = `spot_${Date.now()}`;
  const outputDir = path.join(TEMP_DIR, baseName);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.high;
    
    // Вызываем через python3 -m spotdl для надежности
    const args = [
        '-m', 'spotdl',
        'download', // Возвращаем команду download
        url,
        '--format', 'mp3',
        '--bitrate', preset.bitrate.toLowerCase(),
        '--output', '{title} - {artist}.{output-ext}',
        '--threads', '1',
        '--no-cache'
    ];

    if (SPOTIPY_CLIENT_ID && SPOTIPY_CLIENT_SECRET) {
        args.push('--client-id', SPOTIPY_CLIENT_ID, '--client-secret', SPOTIPY_CLIENT_SECRET);
    }

    if (PROXY_URL) {
        args.push('--proxy', PROXY_URL);
    }

    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookie-file', COOKIES_PATH);
        console.log('[spotdl] Использую куки для авторизации');
    }

    console.log(`[spotdl] Запуск: python3 ${args.join(' ')}`);
    
    const proc = spawn('python3', args, { cwd: outputDir });

    proc.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('ERROR') || msg.includes('Exception')) {
          console.error(`[spotdl] stderr: ${msg.trim()}`);
      }
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`spotdl exited with code ${code}`));
      }
      
      const files = fs.readdirSync(outputDir);
      if (files.length === 0) {
        return reject(new Error('spotdl не создал файл'));
      }
      
      const filePath = path.join(outputDir, files[0]);
      console.log(`[spotdl] Скачан: ${filePath}`);
      resolve(filePath);
    });

    proc.on('error', (err) => {
      reject(new Error(`spotdl spawn error: ${err.message}`));
    });
  });
}

/**
 * Скачивает трек через yt-dlp и возвращает поток (без записи на диск)
 */
async function downloadWithYtdlpStream(url) {
  const { spawn } = await import('child_process');
  
  return new Promise((resolve, reject) => {
    // Формируем аргументы для yt-dlp через python модуль
    const args = [
      '-m', 'yt_dlp',
      url,
      '-f', 'bestaudio',
      '-o', '-',  // Вывод в stdout
      '--no-playlist',
      '--no-warnings',
      '--quiet',
      '--no-check-certificates',
      '--geo-bypass',
      // Улучшенные аргументы для обхода блокировок
      '--extractor-args', 'youtube:player_client=web_embedded,web_music;skip=dash,hls',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];
    
    if (fs.existsSync(COOKIES_PATH)) {
      args.push('--cookies', COOKIES_PATH);
      console.log('[yt-dlp/stream] Использую куки для авторизации');
    }
    
    if (PROXY_URL) {
      args.push('--proxy', PROXY_URL);
      console.log(`[yt-dlp/stream] Использую прокси: ${PROXY_URL.split('@').pop()}`); // Скрываем логин/пароль
    }
    
    console.log(`[yt-dlp/stream] Запуск: python3 ${args.slice(0, 4).join(' ')}...`);
    
    const proc = spawn('python3', args);
    
    const chunks = [];
    
    proc.stdout.on('data', (chunk) => {
      chunks.push(chunk);
    });
    
    proc.stderr.on('data', (data) => {
      const msg = data.toString();
      if (!msg.includes('WARNING')) {
        console.log(`[yt-dlp/stream] stderr: ${msg.slice(0, 100)}`);
      }
    });
    
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp exited with code ${code}`));
      }
      
      if (chunks.length === 0) {
        return reject(new Error('yt-dlp не вернул данные'));
      }
      
      const buffer = Buffer.concat(chunks);
      console.log(`[yt-dlp/stream] Получено ${buffer.length} bytes`);
      
      // Создаём readable stream из буфера
      const { Readable } = require('stream');
      const stream = Readable.from(buffer);
      resolve(stream);
    });
    
    proc.on('error', (err) => {
      reject(new Error(`yt-dlp spawn error: ${err.message}`));
    });
  });
}

/**
 * Скачивает трек через yt-dlp в файл (fallback)
 */
async function downloadWithYtdlp(url, quality = 'high') {
  const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.high;
  const baseName = `dl_${Date.now()}`;
  const outputPath = path.join(TEMP_DIR, `${baseName}.mp3`);
  
  const options = {
    output: outputPath,
    format: 'bestaudio',
    'extract-audio': true,
    'audio-format': 'mp3',
    'audio-quality': preset.bitrate,
    'no-playlist': true,
    'no-warnings': true,
    'ffmpeg-location': ffmpegPath,
    proxy: PROXY_URL || undefined,
    'no-check-certificates': true,
    'add-header': [
      'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
    ]
  };
  
  console.log(`[yt-dlp] Скачиваю в файл: ${url}`);
  
  try {
    await ytdl(url, options);
  } catch (e) {
    console.error(`[yt-dlp] Ошибка:`, e.stderr || e.message);
    throw e;
  }
  
  // Проверяем файл
  if (!fs.existsSync(outputPath)) {
    // Ищем файл с любым расширением
    const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(baseName));
    if (files.length > 0) {
      return path.join(TEMP_DIR, files[0]);
    }
    throw new Error('Файл не создан');
  }
  
  console.log(`[yt-dlp] Скачан: ${outputPath} (${fs.statSync(outputPath).size} bytes)`);
  return outputPath;
}

// --- Вспомогательные функции ---

function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return 'track';
  return name.replace(/[<>:"/\\|?*]+/g, '').trim() || 'track';
}

function getCacheKey(meta, fallbackUrl) {
  if (meta?.id) return `sc:${meta.id}`;
  return fallbackUrl || 'unknown';
}

async function safeSendMessage(userId, text, extra = {}) {
  try {
    return await bot.telegram.sendMessage(userId, text, extra);
  } catch (e) {
    // Если юзер заблокировал бота (403)
    if (e.response?.error_code === 403) {
      await db.updateUserField(userId, 'active', false).catch(() => {});
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

// Преобразует данные от ytdl/scdl в наш формат
function extractMetadataFromInfo(info) {
  const e = Array.isArray(info?.entries) ? info.entries[0] : info;
  if (!e) return null;
  return {
    id: e.id,
    webpage_url: e.webpage_url || e.url,
    title: sanitizeFilename(e.title || 'Unknown Title'),
    uploader: e.uploader || 'Unknown Artist',
    duration: e.duration,
    thumbnail: e.thumbnail,
  };
}

// Гарантирует наличие метаданных (если их нет, качает через ytdl)
async function ensureTaskMetadata(task) {
  let { metadata, cacheKey } = task;
  const url = task.url || task.originalUrl;
  
  if (!metadata) {
    if (!url) throw new Error('TASK_MISSING_URL');
    console.warn('[Worker] metadata отсутствует, получаю через ytdl для URL:', url);
    // Добавляем ignore-errors, чтобы не падать на playlist entries
    const info = await ytdl(url, { 'dump-single-json': true, 'no-playlist': true, 'ignore-errors': true, ...YTDL_COMMON });
    metadata = extractMetadataFromInfo(info);
    if (!metadata) throw new Error('META_MISSING');
  }
  
  if (!cacheKey) {
    cacheKey = getCacheKey(metadata, task.originalUrl || url);
  }
  return { metadata, cacheKey, url };
}
/**
 * Скачивает трек и возвращает file_id из Telegram
 * Используется для "Исправить и отправить"
 */
export async function downloadTrackForUser(url, userId, metadata = null) {
  let tempFilePath = null;
  
  try {
    // Получаем метаданные если нет
    if (!metadata) {
      const info = await ytdl(url, { 
        'dump-single-json': true, 
        'skip-download': true,
        ...YTDL_OPTIONS 
      });
      metadata = extractMetadataFromInfo(info);
    }
    
    if (!metadata) throw new Error('META_MISSING');
    
    const { title, uploader, duration, webpage_url: fullUrl } = metadata;
    const roundedDuration = duration ? Math.round(duration) : null;
    
    console.log(`[DownloadForUser] Скачиваю: "${title}" для User ${userId}`);
    
    let audioSource;
    let method = 'unknown';
    
    // Пробуем SCDL Stream
    try {
      const result = await downloadWithScdlStream(fullUrl || url, title, uploader, roundedDuration);
      audioSource = { source: result.stream, filename: `${sanitizeFilename(title)}.mp3` };
      method = 'SCDL';
    } catch (scdlErr) {
      console.log(`[DownloadForUser] SCDL failed: ${scdlErr.message}, trying YT-DLP...`);
      
      // Fallback на YT-DLP
      const result = await downloadWithYtdlpFile(fullUrl || url, roundedDuration);
      tempFilePath = result.filePath;
      audioSource = { source: fs.createReadStream(tempFilePath), filename: `${sanitizeFilename(title)}.mp3` };
      method = 'YT-DLP';
    }
    
    // Отправляем в хранилище
    if (STORAGE_CHANNEL_ID) {
      const sentMsg = await bot.telegram.sendAudio(
        STORAGE_CHANNEL_ID,
        audioSource,
        { title, performer: uploader }
      );
      
      const realDuration = sentMsg.audio?.duration || 0;
      const fileId = sentMsg.audio?.file_id;
      
      // Проверка на превью
      if (roundedDuration && roundedDuration > 60 && realDuration < 35) {
        await bot.telegram.deleteMessage(STORAGE_CHANNEL_ID, sentMsg.message_id).catch(() => {});
        throw new Error('PREVIEW_ONLY');
      }
      
      // Кэшируем
      await db.cacheTrack({
        url: fullUrl || url,
        fileId,
        title,
        artist: uploader,
        duration: realDuration,
        thumbnail: metadata.thumbnail
      });
      
      // Отправляем пользователю
      await bot.telegram.sendAudio(userId, fileId, {
        title,
        performer: uploader,
        duration: realDuration
      });
      
      console.log(`[DownloadForUser] ✅ Успешно (${method}): "${title}" → User ${userId}`);
      
      return { success: true, fileId, title, method };
    } else {
      throw new Error('STORAGE_NOT_CONFIGURED');
    }
    
  } catch (err) {
    console.error(`[DownloadForUser] ❌ Ошибка:`, err.message);
    throw err;
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch (e) {}
    }
  }
}

// =====================================================================================
//                             ГЛАВНЫЙ ПРОЦЕССОР ЗАГРУЗКИ
// =====================================================================================

export async function trackDownloadProcessor(task) {
  let statusMessage = null;
  let tempFilePath = null;
  let thumbPath = null;
  const userId = parseInt(task.userId, 10);
  const source = task.source || 'soundcloud';
  const quality = task.quality || 'high';
  
  try {
    // 1. Проверка лимитов
    const usage = await getUserUsage(userId);
    if (!usage || usage.downloads_today >= usage.premium_limit) {
      await safeSendMessage(userId, T('limitReached'));
      return;
    }

    // 2. Получение метаданных
    let metadata, cacheKey, fullUrl, title, uploader, roundedDuration;
    
    if (source === 'spotify' || source === 'youtube') {
      // Spotify/YouTube - метаданные уже есть в task, URL = поисковый запрос
      metadata = task.metadata || {};
      title = metadata.title || 'Unknown';
      uploader = metadata.uploader || 'Unknown';
      roundedDuration = metadata.duration ? Math.round(metadata.duration) : undefined;
      fullUrl = task.url; // ytsearch1:... или youtube url
      cacheKey = `${source}:${title}:${uploader}`;
    } else {
      // SoundCloud - старая логика
      const ensured = await ensureTaskMetadata(task);
      metadata = ensured.metadata;
      cacheKey = ensured.cacheKey;
      title = metadata.title;
      uploader = metadata.uploader;
      roundedDuration = metadata.duration ? Math.round(metadata.duration) : undefined;
      fullUrl = metadata.webpage_url || task.url;
    }
    
    if (!fullUrl) throw new Error(`Нет ссылки на трек: ${title}`);

    // 3. Проверка КЭША
    let cached = await db.findCachedTrack(cacheKey);
    if (cached?.fileId) {
      console.log(`[Worker/Cache] ХИТ! Отправляю "${cached.title}" из кэша.`);
      await bot.telegram.sendAudio(userId, cached.fileId, { title: cached.title, performer: cached.artist || uploader, duration: roundedDuration });
      await incrementDownload(userId, cached.title, cached.fileId, cacheKey);
      return;
    }

    const qualityLabel = QUALITY_PRESETS[quality]?.label || quality;
    statusMessage = await safeSendMessage(userId, `⏳ Скачиваю: "${title}" (${qualityLabel})`);
    
    let stream;
    let usedFallback = false;

    // 4. СКАЧИВАНИЕ - ПРИОРИТЕТ ПОТОКОВОЙ ОТПРАВКЕ
    if (source === 'soundcloud' && fullUrl.includes('soundcloud.com')) {
      // SoundCloud - потоковая через scdl
      try {
        console.log(`[Worker/Stream] (SCDL) Потоковое скачивание: ${fullUrl}`);
        stream = await scdl.default.download(fullUrl);
      } catch (scdlError) {
        console.warn(`[Worker] SCDL ошибка (${scdlError.message}). Fallback на YT-DLP stream...`);
        stream = await downloadWithYtdlpStream(fullUrl);
        usedFallback = true;
      }
    } else if (source === 'spotify' && task.originalUrl?.includes('spotify.com')) {
      // Spotify - используем spotdl для лучшего качества и метаданных
      console.log(`[Worker/spotify] Скачивание через spotdl: ${task.originalUrl}`);
      try {
        tempFilePath = await downloadWithSpotdl(task.originalUrl, quality);
        stream = fs.createReadStream(tempFilePath);
        usedFallback = true;
      } catch (spotdlErr) {
        console.warn(`[Worker] spotdl ошибка (${spotdlErr.message}). Fallback на YT-DLP stream...`);
        // Если spotdl упал, пробуем поиск на YouTube через ytsearch
        const cleanQuery = `${title} ${uploader}`;
        stream = await downloadWithYtdlpStream(`ytsearch1:${cleanQuery}`);
        usedFallback = false;
      }
    } else {
      // YouTube или поиск - потоковая через yt-dlp
      let searchUrl = fullUrl;
      if (!fullUrl.startsWith('http')) {
        const cleanQuery = fullUrl.replace(/^(ytsearch1:|ytmsearch1:)/, '');
        searchUrl = `ytmsearch1:${cleanQuery}`; // Возвращаем YouTube Music
      }
      
      console.log(`[Worker/${source}] Потоковое скачивание через yt-dlp: ${searchUrl}`);
      try {
        stream = await downloadWithYtdlpStream(searchUrl);
      } catch (streamErr) {
        console.warn(`[Worker] Stream ошибка (${streamErr.message}). Fallback на файл...`);
        tempFilePath = await downloadWithYtdlp(searchUrl, quality);
        stream = fs.createReadStream(tempFilePath);
        usedFallback = true;
      }
    }

    // 5. ОТПРАВКА В TELEGRAM
    let finalFileId = null;

    // Скачиваем обложку
    if (metadata.thumbnail) {
      thumbPath = await downloadThumbnail(metadata.thumbnail);
    }

    // А) В канал-хранилище (если настроен)
    if (STORAGE_CHANNEL_ID) {
      try {
        console.log(`[Worker/Stream] Отправка в хранилище...`);
        const audioOpts = { title, performer: uploader, duration: roundedDuration };
        if (thumbPath) audioOpts.thumb = { source: thumbPath };
        
        const sentToStorage = await bot.telegram.sendAudio(
          STORAGE_CHANNEL_ID,
          { source: stream, filename: `${sanitizeFilename(title)}.mp3` },
          audioOpts
        );
        finalFileId = sentToStorage?.audio?.file_id;
      } catch (e) {
        console.error(`❌ Ошибка отправки в хранилище:`, e.message);
        // Если использовали fallback (файл), можно пересоздать стрим
        if (usedFallback && fs.existsSync(tempFilePath)) {
            stream = fs.createReadStream(tempFilePath); 
        }
        // Если scdl, стрим умер, но код пойдет ниже в блок "else" и попробует отправить что есть или упадет
      }
    }

    // Б) Если получили file_id -> Сохраняем в БД и отправляем юзеру
    if (finalFileId) {
        const urlAliases = [];
        if (task.originalUrl && task.originalUrl !== fullUrl) urlAliases.push(task.originalUrl);
        if (cacheKey && !cacheKey.startsWith('http')) urlAliases.push(cacheKey);
        
        await db.cacheTrack({ 
            url: fullUrl, 
            fileId: finalFileId, 
            title, 
            artist: uploader, 
            duration: roundedDuration, 
            thumbnail: metadata.thumbnail, 
            aliases: urlAliases 
        });
        
        console.log(`✅ [Cache] Трек "${title}" сохранён.`);
        await bot.telegram.sendAudio(userId, finalFileId, { title, performer: uploader, duration: roundedDuration });
        await incrementDownload(userId, title, finalFileId, task.originalUrl || fullUrl);

    } else {
      // В) Если хранилище недоступно -> Отправляем файл напрямую юзеру
      console.warn('[Worker] Отправляю напрямую пользователю (без кэша)...');
      
      // Перестраховка для стрима
      if (usedFallback && fs.existsSync(tempFilePath)) {
          stream = fs.createReadStream(tempFilePath);
      } else if (!usedFallback && (!stream || stream.destroyed)) {
           // Если scdl стрим сдох, пробуем еще раз scdl (шанс мал, но все же)
           try { stream = await scdl.default.download(fullUrl); } catch(e) { throw new Error('Повторное скачивание failed'); }
      }

      await bot.telegram.sendAudio(
        userId, 
        { source: stream, filename: `${sanitizeFilename(title)}.mp3` },
        { title, performer: uploader, duration: roundedDuration }
      );
    }

  } catch (err) {
    const errorDetails = err?.stderr || err?.message || 'Unknown error';
    console.error(`❌ Ошибка воркера (User ${userId}):`, errorDetails);
    
    let userMsg = `❌ Не удалось обработать трек`;
    const trackTitle = task.metadata?.title || 'Unknown';
    const trackUrl = task.url || task.originalUrl || '';
    
    if (trackTitle !== 'Unknown') userMsg += `: "${trackTitle}"`;
    
    // Определяем причину ошибки для логирования
    let reason = 'UNKNOWN_ERROR';
    if (errorDetails.includes('404') || errorDetails.includes('Video unavailable')) {
         userMsg += "\n(Трек удален или приватный)";
         reason = '404_NOT_FOUND';
    } else if (errorDetails.includes('403')) {
         reason = '403_FORBIDDEN';
    } else if (errorDetails.includes('PREVIEW') || errorDetails.includes('preview')) {
         reason = 'PREVIEW_ONLY';
    } else if (errorDetails.includes('timeout') || errorDetails.includes('TIMEOUT')) {
         reason = 'TIMEOUT';
    }
    
    // Логируем битый трек в БД
    await db.logBrokenTrack(trackUrl, trackTitle, userId, reason).catch(() => {});

    await safeSendMessage(userId, userMsg);

  } finally {
    // 6. ОЧИСТКА
    if (statusMessage) {
      try { await bot.telegram.deleteMessage(userId, statusMessage.message_id); } catch (e) {}
    }
    
    // Удаляем файл или целую папку (для spotdl)
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        const stats = fs.statSync(tempFilePath);
        const parentDir = path.dirname(tempFilePath);
        
        // Удаляем файл
        fs.unlinkSync(tempFilePath);
        
        // Если это была временная папка spotdl (имя начинается на spot_), удаляем её целиком
        if (path.basename(parentDir).startsWith('spot_')) {
          fs.rmSync(parentDir, { recursive: true, force: true });
        }
      } catch (e) {}
    }
    
    if (thumbPath && fs.existsSync(thumbPath)) {
      try { fs.unlinkSync(thumbPath); } catch (e) {}
    }
  }
}

// =====================================================================================
//                                 ОЧЕРЕДЬ ЗАГРУЗОК
// =====================================================================================

export const downloadQueue = new TaskQueue({
  maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
  taskProcessor: trackDownloadProcessor
});

console.log(`[DownloadManager] Очередь (threads=${MAX_CONCURRENT_DOWNLOADS})`);

// =====================================================================================
//                                 ФУНКЦИЯ ENQUEUE
// =====================================================================================

export function enqueue(ctx, userId, url, earlyData = {}) {
  (async () => {
    let statusMessage = null;
    console.log(`[Enqueue] User ${userId}, URL: ${url}`);
    
    try {
      // Проверка бонусов/лимитов
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

      // 1. FAST PATH (если метаданные уже есть из поиска)
      if (earlyData.isSingleTrack && earlyData.metadata) {
        console.log('[Enqueue/Fast] Метаданные получены заранее.');
        const metadata = extractMetadataFromInfo(earlyData.metadata);
        const { webpage_url: fullUrl, id } = metadata;
        const cacheKey = id ? `sc:${id}` : null;

        // Проверка кэша
        const cached = await db.findCachedTrack(url) || await db.findCachedTrack(fullUrl) || (cacheKey && await db.findCachedTrack(cacheKey));
        if (cached?.fileId) {
          console.log(`[Enqueue/Fast] ХИТ КЭША!`);
          await bot.telegram.sendAudio(userId, cached.fileId, { title: cached.title, performer: cached.artist });
          await incrementDownload(userId, cached.title, cached.fileId, url);
          return;
        }

        // Добавляем в очередь
        const task = { userId, url: fullUrl, originalUrl: url, source: 'soundcloud', cacheKey, metadata };
        downloadQueue.add({ ...task, priority: user.premium_limit || 5 });
        await safeSendMessage(userId, `✅ Трек "${metadata.title}" добавлен в очередь.`);
        return;
      }

      // 2. SLOW PATH (Если просто кинули ссылку)
      // Сначала проверим кэш по URL, чтобы не делать лишних запросов
      const quickCache = await db.findCachedTrack(url);
      if (quickCache?.fileId) {
          console.log(`[Enqueue/Slow] ХИТ КЭША по URL!`);
          await bot.telegram.sendAudio(userId, quickCache.fileId, { title: quickCache.title, performer: quickCache.artist });
          await incrementDownload(userId, quickCache.title, quickCache.fileId, url);
          return;
      }

      statusMessage = await safeSendMessage(userId, '🔍 Анализирую ссылку...');
      
      // Получаем инфо через yt-dlp
      const info = await ytdl(url, { 'dump-single-json': true, 'flat-playlist': true, ...YTDL_COMMON });
      
      // Удаляем сообщение "Анализирую..."
      if (statusMessage) {
        await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
      }

      // Это плейлист?
      if (info.entries && info.entries.length > 0) {
          await safeSendMessage(userId, `📂 Найден плейлист/альбом: "${info.title || 'Playlist'}".\nДобавляю ${info.entries.length} треков...`);
          
          let addedCount = 0;
          for (const entry of info.entries) {
              const meta = extractMetadataFromInfo(entry);
              if (meta) {
                  const task = { userId, url: meta.webpage_url, originalUrl: url, source: 'soundcloud', metadata: meta };
                  downloadQueue.add({ ...task, priority: user.premium_limit || 5 });
                  addedCount++;
              }
          }
          await safeSendMessage(userId, `✅ Добавлено в очередь: ${addedCount} треков.`);
      } else {
          // Одиночный трек
          const meta = extractMetadataFromInfo(info);
          if (meta) {
              const task = { userId, url: meta.webpage_url, originalUrl: url, source: 'soundcloud', metadata: meta };
              downloadQueue.add({ ...task, priority: user.premium_limit || 5 });
              await safeSendMessage(userId, `✅ Трек "${meta.title}" добавлен в очередь.`);
          } else {
              throw new Error('Не удалось извлечь данные о треке.');
          }
      }

    } catch (err) {
      console.error(`[Enqueue] Ошибка:`, err.message);
      if (statusMessage) {
        await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
      }
      await safeSendMessage(userId, `❌ Ошибка при чтении ссылки. Возможно, она приватная или неверная.`);
    }
  })().catch(e => console.error('Async Enqueue Error:', e));
}

export function initializeDownloadManager() {
  console.log('[DownloadManager] Готов к работе.');
}