// =========================================================================
//        ФИНАЛЬНАЯ ВЕРСИЯ downloadManager.js, ОСНОВАННАЯ НА ВАШЕМ КОДЕ (v3)
// =========================================================================

import path from 'path';
import fs from 'fs';
import ytdl from 'youtube-dl-exec';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import pTimeout, { TimeoutError } from 'p-timeout';

import { TaskQueue } from '../lib/TaskQueue.js';
import { getRedisClient } from './redisService.js';
import { bot } from '../bot.js';
import { T } from '../config/texts.js';
import {
    getUser, resetDailyLimitIfNeeded, saveTrackForUser, logEvent,
    incrementDownloads, updateUserField, findCachedTrack, cacheTrack // Убрали findCachedTracksByUrls
} from '../db.js';

const CONFIG = {
  TELEGRAM_FILE_LIMIT_MB: 49,
  MAX_PLAYLIST_TRACKS_FREE: 10,
  TRACK_TITLE_LIMIT: 100,
  MAX_CONCURRENT_DOWNLOADS: 1,
  METADATA_FETCH_TIMEOUT_MS: 45000,
  YTDL_RETRIES: 3,
  SOCKET_TIMEOUT: 120,
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(import.meta.url));
const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

function sanitizeFilename(name) {
  return (name || 'track').replace(/[<>:"/\\|?*]+/g, '').trim().slice(0, CONFIG.TRACK_TITLE_LIMIT);
}

async function safeSendMessage(userId, text, extra = {}) {
  try {
    return await bot.telegram.sendMessage(userId, text, extra);
  } catch (e) {
    if (e.response?.error_code === 403) {
      await updateUserField(userId, 'active', false);
    }
    return null;
  }
}

function getYtdlErrorMessage(err) {
  if (err instanceof TimeoutError) return 'Сервис отвечает слишком долго.';
  if (err.stderr?.includes('Unsupported URL')) return 'Неподдерживаемая ссылка.';
  if (err.stderr?.includes('Video unavailable')) return 'Трек недоступен.';
  if (err.stderr?.includes('404')) return 'Трек не найден (ошибка 404).';
  return 'Не удалось получить метаданные.';
}

async function trackDownloadProcessor(task) {
  const { userId, url, trackName, uploader, playlistUrl } = task;
  const tempFilename = `${sanitizeFilename(trackName)}-${crypto.randomUUID()}.mp3`;
  const tempFilePath = path.join(cacheDir, tempFilename);

  try {
    await logEvent(userId, 'download_start', { url, title: trackName });
    console.log(`[Worker] Скачивание: ${trackName}`);

    await ytdl(url, {
      extractAudio: true,
      audioFormat: 'mp3',
      output: tempFilePath,
      embedMetadata: true,
      postprocessorArgs: `-metadata artist="${uploader || 'SoundCloud'}" -metadata title="${trackName}"`,
      retries: CONFIG.YTDL_RETRIES,
      "socket-timeout": CONFIG.SOCKET_TIMEOUT,
      'ffmpeg-location': '/usr/bin/ffmpeg'
    });

    if (!fs.existsSync(tempFilePath)) throw new Error('Файл не создан после загрузки.');
    
    const stats = await fs.promises.stat(tempFilePath);
    if (stats.size / (1024 * 1024) > CONFIG.TELEGRAM_FILE_LIMIT_MB) {
      await safeSendMessage(userId, `⚠️ Трек "${trackName}" слишком большой.`);
      return;
    }

    const sentMessage = await bot.telegram.sendAudio(
      userId,
      { source: fs.createReadStream(tempFilePath) },
      { title: trackName, performer: uploader || 'SoundCloud' }
    );

    if (sentMessage?.audio?.file_id) {
      await cacheTrack(url, sentMessage.audio.file_id, trackName, uploader);
      await saveTrackForUser(userId, trackName, sentMessage.audio.file_id);
      await incrementDownloads(userId);
    }

    const redisClient = getRedisClient();
    if (playlistUrl && redisClient) {
      const playlistKey = `playlist:${userId}:${playlistUrl}`;
      const remaining = await redisClient.decr(playlistKey);
      if (remaining <= 0) {
        await safeSendMessage(userId, '✅ Все треки из плейлиста загружены.');
        await redisClient.del(playlistKey);
      }
    }
  } catch (err) {
    await safeSendMessage(userId, `❌ Ошибка обработки "${trackName}"`);
    console.error(`[Worker] Ошибка: ${err.stderr || err.message}`);
  } finally {
    if (fs.existsSync(tempFilePath)) {
      await fs.promises.unlink(tempFilePath).catch(e => console.error(`Ошибка удаления ${tempFilePath}:`, e));
    }
  }
}

export const downloadQueue = new TaskQueue({
  maxConcurrent: CONFIG.MAX_CONCURRENT_DOWNLOADS,
  taskProcessor: trackDownloadProcessor
});

async function getTracksInfo(url) {
  let downloadUrl = url;
  if (!url.startsWith('http')) {
      downloadUrl = `ytsearch1:"${url}"`;
      console.log(`[getTracksInfo] Ищем на YouTube: ${downloadUrl}`);
  }
  const info = await pTimeout(
    ytdl(downloadUrl, { dumpSingleJson: true, retries: CONFIG.YTDL_RETRIES, "socket-timeout": CONFIG.SOCKET_TIMEOUT }),
    { milliseconds: CONFIG.METADATA_FETCH_TIMEOUT_MS }
  );
  const isPlaylist = Array.isArray(info.entries) && info.entries.length > 0;
  const tracks = (isPlaylist ? info.entries : [info]).map(e => ({
    url: e.webpage_url,
    trackName: sanitizeFilename(e.title),
    uploader: e.uploader || 'SoundCloud'
  })).filter(t => t.url);

  if (!tracks.length) throw new Error('Треки не найдены.');
  return { tracks, isPlaylist };
}

function applyUserLimits(tracks, user, isPlaylist) {
    if (isPlaylist && !user.is_premium && tracks.length > CONFIG.MAX_PLAYLIST_TRACKS_FREE) {
        safeSendMessage(user.id, `ℹ️ Бесплатный лимит: ${CONFIG.MAX_PLAYLIST_TRACKS_FREE} треков из плейлиста.`);
        return tracks.slice(0, CONFIG.MAX_PLAYLIST_TRACKS_FREE);
    }
    return tracks;
}

// <<< ИСПРАВЛЕННАЯ ВЕРСИЯ >>>
async function sendCachedTracks(tracks, userId) {
  const tasksToDownload = [];
  let sentFromCacheCount = 0;

  for (const track of tracks) {
    const cached = await db.findCachedTrack(track.url); // Используем findCachedTrack
    if (cached) {
      try {
        await bot.telegram.sendAudio(userId, cached.fileId, { title: track.trackName, performer: track.uploader });
        await saveTrackForUser(userId, track.trackName, cached.fileId);
        await incrementDownloads(userId);
        sentFromCacheCount++;
      } catch (err) {
        if (err.description?.includes('FILE_REFERENCE_EXPIRED')) tasksToDownload.push(track);
      }
    } else {
      tasksToDownload.push(track);
    }
  }

  if (sentFromCacheCount > 0) {
    await safeSendMessage(userId, `✅ ${sentFromCacheCount} трек(ов) отправлено из кэша.`);
  }
  return tasksToDownload;
}

async function queueRemainingTracks(tracks, userId, isPlaylist, originalUrl) {
  if (!tracks.length) return;

  const user = await getUser(userId);
  const remainingLimit = (user.premium_limit || 0) - (user.downloads_today || 0);
  if (remainingLimit <= 0) return safeSendMessage(userId, T('limitReached') || '🚫 Лимит исчерпан.');

  const finalTasks = tracks.slice(0, remainingLimit);
  if (tracks.length > remainingLimit) await safeSendMessage(userId, `⚠️ Загружаю только ${remainingLimit} треков из-за дневного лимита.`);

  if (finalTasks.length) {
    await safeSendMessage(userId, `⏳ В очереди ${finalTasks.length} трек(ов).`);
    const redisClient = getRedisClient();
    if (isPlaylist && redisClient) {
        const playlistKey = `playlist:${userId}:${originalUrl}`;
        await redisClient.setEx(playlistKey, 3600, finalTasks.length.toString());
    }

    for (const track of finalTasks) {
      downloadQueue.add({ userId, ...track, playlistUrl: isPlaylist ? originalUrl : null, priority: user.premium_limit });
    }
  }
}

export async function enqueue(ctx, userId, url) {
  const processingMessage = await safeSendMessage(userId, '🔍 Анализирую ссылку...');
  try {
    await resetDailyLimitIfNeeded(userId);
    const user = await getUser(userId);

    if (((user.premium_limit || 0) - (user.downloads_today || 0)) <= 0) {
        if (processingMessage) await bot.telegram.deleteMessage(userId, processingMessage.message_id).catch(() => {});
        return await safeSendMessage(userId, T('limitReached'));
    }

    const { tracks, isPlaylist } = await getTracksInfo(url);
    const limitedTracks = applyUserLimits(tracks, user, isPlaylist);
    const tasksToDownload = await sendCachedTracks(limitedTracks, userId);
    await queueRemainingTracks(tasksToDownload, userId, isPlaylist, url);

    if (processingMessage) await bot.telegram.deleteMessage(userId, processingMessage.message_id).catch(() => {});
  } catch (err) {
    console.error(`[Enqueue] Ошибка для ${userId}: ${err.message}`);
    const userErrorMessage = getYtdlErrorMessage(err);
    if (processingMessage) {
        await bot.telegram.editMessageText(userId, processingMessage.message_id, undefined, `❌ Ошибка: ${userErrorMessage}`).catch(() => {});
    } else {
        await safeSendMessage(userId, `❌ Ошибка: ${userErrorMessage}`);
    }
  }
}