// =====================================================================================
//      СКОПИРУЙТЕ ВЕСЬ ЭТОТ КОД И ПОЛНОСТЬЮ ЗАМЕНИТЕ ИМ СОДЕРЖИМОЕ
//                       ФАЙЛА services/downloadManager.js
// =====================================================================================

import path from 'path';
import { fileURLToPath } from 'url';
import scdl from 'soundcloud-downloader';
import ytdl from 'youtube-dl-exec';
import { bot } from '../bot.js';
import * as db from '../db.js';
import { TaskQueue } from '../lib/TaskQueue.js';
import { PROXY_URL, STORAGE_CHANNEL_ID } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));

const YTDL_BINARY_PATH = path.join(__dirname, '..', 'bin', 'yt-dlp');
const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10) || 2;

const YTDL_COMMON = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36', // <--- ДОБАВЛЯЕМ
  proxy: PROXY_URL,
  retries: 3,
  'socket-timeout': 60,
  'no-warnings': true,
};

async function safeSendMessage(userId, text, extra = {}) {
  try {
    return await bot.telegram.sendMessage(userId, text, extra);
  } catch (e) {
    if (e.response?.error_code === 403) {
      await db.updateUserField(userId, 'active', false).catch(() => {});
    }
    return null;
  }
}

function extractYtdlMetadata(info) {
  const e = Array.isArray(info?.entries) ? info.entries[0] : info;
  if (!e) return null;
  return {
    id: e.id,
    webpage_url: e.webpage_url,
    title: e.title || 'Unknown Title',
    uploader: e.uploader || 'Unknown Artist',
    duration: e.duration,
    thumbnail: e.thumbnail,
  };
}

async function ensureTaskMetadata(task) {
  if (task.metadata) return task;
  
  console.warn(`[Worker] metadata отсутствует, получаю через ytdl для URL: ${task.url}`);
  const info = await ytdl(task.url, { 'dump-single-json': true, 'no-playlist': true, ...YTDL_COMMON }, { ytdlPath: YTDL_BINARY_PATH });
  task.metadata = extractYtdlMetadata(info);
  
  if (!task.metadata) throw new Error('META_MISSING');
  return task;
}

// УНИВЕРСАЛЬНЫЙ СТРИМИНГОВЫЙ ВОРКЕР
export async function trackDownloadProcessor(initialTask) {
  let task = await ensureTaskMetadata(initialTask);
  const { userId, url, metadata, source, originalUrl } = task;
  const { title, uploader, duration } = metadata;
  
  let statusMessage = null;
  
  try {
    const user = await db.getUser(userId);
    if ((user.downloads_today || 0) >= user.premium_limit) {
      return await safeSendMessage(userId, 'Лимит скачиваний исчерпан.');
    }
    
    const cacheKey = originalUrl || url;
    const cached = await db.findCachedTrack(cacheKey);
    if (cached?.fileId) {
      console.log(`[Worker/Cache] ХИТ для "${title}"! Отправляю из кэша.`);
      await bot.telegram.sendAudio(userId, cached.fileId, { title: cached.trackName || title, performer: cached.artist || uploader, duration: cached.duration });
      await db.incrementDownloadsAndSaveTrack(userId, title, cached.fileId, cacheKey);
      return;
    }
    
    statusMessage = await safeSendMessage(userId, `⏳ Обрабатываю: "${title}"...`);
    let finalFileId = null;
    let stream = null;
    
    if (source === 'soundcloud') {
      // === БЫСТРАЯ СТРАТЕГИЯ ДЛЯ SOUNDCLOUD (ПОТОК) ===
      console.log(`[Worker/SoundCloud] Открываю аудиопоток для: ${url}`);
      stream = await scdl.default.download(url);
      
    } else if (source === 'spotify') {
      // === БЫСТРАЯ СТРАТЕГИЯ ДЛЯ SPOTIFY (ПОТОК ИЗ YOUTUBE) ===
      console.log(`[Worker/Spotify] Запускаю yt-dlp в режиме потока для: ${url}`);
      
      const ytdlProcess = ytdl.exec(url, {
        output: '-', // ВЫВОДИТЬ В STDOUT
        format: 'bestaudio[ext=m4a]/bestaudio/best',
        ...YTDL_COMMON
      }, { stdio: ['ignore', 'pipe', 'pipe'], ytdlPath: YTDL_BINARY_PATH });
      
      stream = ytdlProcess.stdout; // БЕРЕМ ПОТОК НАПРЯМУЮ
      
      // Ждем завершения процесса, чтобы поймать возможные ошибки
      await new Promise((resolve, reject) => {
        let errorOutput = '';
        ytdlProcess.stderr.on('data', (data) => { errorOutput += data.toString(); });
        
        stream.on('end', resolve);
        stream.on('error', (err) => reject(new Error(`Ошибка потока yt-dlp: ${err.message}`)));
        ytdlProcess.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`yt-dlp завершился с кодом ${code}:\n${errorOutput}`));
          }
          // Если код 0, просто ждем завершения потока (событие 'end')
        });
      });
      
    } else {
      throw new Error(`Неизвестный источник задачи: ${source}`);
    }
    
    if (!stream) { throw new Error('Не удалось создать аудиопоток.'); }
    
    // Отправляем поток в канал для кэширования
    const sentMessage = await bot.telegram.sendAudio(STORAGE_CHANNEL_ID, { source: stream }, { title, performer: uploader, duration });
    finalFileId = sentMessage.audio.file_id;
    
    if (finalFileId) {
      await db.cacheTrack({ url: cacheKey, fileId: finalFileId, title, artist: uploader, duration });
      await db.incrementDownloadsAndSaveTrack(userId, title, finalFileId, cacheKey);
      
      // Отправляем пользователю по file_id (это мгновенно)
      await bot.telegram.sendAudio(userId, finalFileId, { title, performer: uploader, duration });
      console.log(`✅ Трек "${title}" обработан и отправлен.`);
    } else {
      throw new Error('Не удалось получить fileId после загрузки.');
    }
    
    if (statusMessage) {
      await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
    }
    
  } catch (err) {
    console.error(`❌ Ошибка воркера для user ${userId} (source: ${source}):`, err.message);
    await safeSendMessage(userId, `❌ Не удалось обработать трек: "${title || 'Без названия'}"`);
    if (statusMessage) {
      await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
    }
  }
}

export const downloadQueue = new TaskQueue({
  maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
  taskProcessor: trackDownloadProcessor
});

// Упрощенная функция постановки в очередь
export function enqueue(ctx, userId, url, { source, originalUrl, metadata }) {
  (async () => {
    try {
      const user = await db.getUser(userId);
      const priority = user.premium_limit || 5;
      downloadQueue.add({ userId, url, source, originalUrl, metadata, priority });
    } catch (e) {
      console.error('[Enqueue] Ошибка постановки в очередь:', e);
    }
  })();
}

export function initializeDownloadManager() {
  console.log('[DownloadManager] Универсальная стриминговая версия инициализирована.');
}