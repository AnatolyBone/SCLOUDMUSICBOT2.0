// services/downloadManager.js

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
    incrementDownloads, updateUserField, findCachedTracksByUrls, cacheTrack
} from '../db.js';

// --- Конфигурация ---
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
const __dirname = path.dirname(path.dirname(__filename));
const cacheDir = path.join(__dirname, 'cache');

// --- Утилиты ---
function sanitizeFilename(name) {
  return (name || 'track').replace(/[<>:"/\\|?*]+/g, '').trim().slice(0, CONFIG.TRACK_TITLE_LIMIT);
}

async function safeSendMessage(userId, text, extra = {}) {
  try {
    return await bot.telegram.sendMessage(userId, text, extra);
  } catch (e) {
    if (e.response?.error_code === 403) {
      console.warn(`[SafeSend] Пользователь ${userId} заблокировал бота.`);
      await updateUserField(userId, 'active', false);
    } else {
      console.error(`[SafeSend] Ошибка отправки для ${userId}:`, e.message);
    }
    return null;
  }
}

function getYtdlErrorMessage(err) {
  if (err instanceof TimeoutError || err.message?.includes('Превышен таймаут')) {
    return 'Не удалось получить информацию о плейлисте (слишком большой или сервис медленно отвечает).';
  }
  if (err.stderr?.includes('Unsupported URL')) return 'Неподдерживаемая ссылка.';
  if (err.stderr?.includes('Video unavailable')) return 'Трек недоступен.';
  if (err.stderr?.includes('404')) return 'Трек не найден (ошибка 404).';
  if (err.message?.includes('timed out')) return 'Сервис отвечает слишком долго.';
  return 'Не удалось получить метаданные.';
}

// --- Воркер для загрузки ---
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
      await cacheTrack(url, sentMessage.audio.file_id, trackName);
      await saveTrackForUser(userId, trackName, sentMessage.audio.file_id);
      await incrementDownloads(userId);
    }

    if (playlistUrl) {
      const redisClient = getRedisClient();
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

// --- Конвейер обработки ---
async function getTracksInfo(url) {
  // <<< НОВАЯ ЛОГИКА МАРШРУТИЗАЦИИ >>>
  let downloadUrl = url;
  // Если URL не похож на настоящую ссылку, считаем, что это поисковый запрос для YouTube
  if (!url.startsWith('http')) {
      downloadUrl = `ytsearch:"${url}"`;
      console.log(`[getTracksInfo] Обнаружен поисковый запрос, ищем на YouTube: ${downloadUrl}`);
  }

  const info = await pTimeout(
    ytdl(downloadUrl, { dumpSingleJson: true, retries: CONFIG.YTDL_RETRIES, "socket-timeout": CONFIG.SOCKET_TIMEOUT }),
    { milliseconds: CONFIG.METADATA_FETCH_TIMEOUT_MS, message: 'Превышен таймаут получения метаданных.' }
  );

  const isPlaylist = Array.isArray(info.entries) && info.entries.length > 0;
  const tracks = isPlaylist
    ? info.entries.filter(e => e?.webpage_url && e?.id).map(e => ({
        url: e.webpage_url,
        trackName: sanitizeFilename(e.title),
        uploader: e.uploader || 'SoundCloud'
      }))
    : [{
        url: info.webpage_url || url,
        trackName: sanitizeFilename(info.title),
        uploader: info.uploader || 'SoundCloud'
      }];

  if (!tracks.length) throw new Error('Треки не найдены.');
  return { tracks, isPlaylist };
}

function applyUserLimits(tracks, user, isPlaylist) {
  if (isPlaylist && user.premium_limit <= 10 && tracks.length > CONFIG.MAX_PLAYLIST_TRACKS_FREE) {
    safeSendMessage(user.id, `ℹ️ Лимит бесплатного тарифа: ${CONFIG.MAX_PLAYLIST_TRACKS_FREE} треков.`);
    return tracks.slice(0, CONFIG.MAX_PLAYLIST_TRACKS_FREE);
  }
  return tracks;
}

async function sendCachedTracks(tracks, userId) {
  const urls = tracks.map(t => t.url);
  const cachedTracksMap = await findCachedTracksByUrls(urls);
  const tasksToDownload = [];
  let sentFromCacheCount = 0;

  for (const track of tracks) {
    const cached = cachedTracksMap.get(track.url);
    if (cached) {
      try {
        await bot.telegram.sendAudio(userId, cached.fileId, { title: track.trackName, performer: track.uploader });
        await saveTrackForUser(userId, track.trackName, cached.fileId);
        await incrementDownloads(userId);
        sentFromCacheCount++;
      } catch (err) {
        if (err.description?.includes('FILE_REFERENCE_EXPIRED')) tasksToDownload.push(track);
        else console.error(`[Cache] Ошибка для ${userId}: ${err.message}`);
      }
    } else {
      tasksToDownload.push(track);
    }
  }

  if (sentFromCacheCount) await safeSendMessage(userId, `✅ ${sentFromCacheCount} трек(ов) из кэша.`);
  return tasksToDownload;
}

async function queueRemainingTracks(tracks, userId, isPlaylist, originalUrl) {
  if (!tracks.length) return;

  const user = await getUser(userId);
  const remainingLimit = user.premium_limit - user.downloads_today;

  if (remainingLimit <= 0) return safeSendMessage(userId, T('limitReached') || '🚫 Лимит исчерпан.');

  const finalTasks = tracks.length > remainingLimit ? tracks.slice(0, remainingLimit) : tracks;
  if (tracks.length > remainingLimit) await safeSendMessage(userId, `⚠️ Лимит: ${remainingLimit} треков.`);

  if (finalTasks.length) {
    await safeSendMessage(userId, `⏳ В очереди ${finalTasks.length} трек(ов).`);
    if (isPlaylist) {
      const redisClient = getRedisClient();
      const playlistKey = `playlist:${userId}:${originalUrl}`;
      await redisClient.setEx(playlistKey, 3600, finalTasks.length.toString());
      await logEvent(userId, 'download_playlist', { url: originalUrl });
    }

    for (const track of finalTasks) {
      downloadQueue.add({ userId, ...track, playlistUrl: isPlaylist ? originalUrl : null, priority: user.premium_limit });
    }
  }
}

// --- Точка входа ---
export async function enqueue(ctx, userId, url) {
  const processingMessage = await safeSendMessage(userId, '🔍 Анализирую ссылку...');
  try {
    await resetDailyLimitIfNeeded(userId);
    const user = await getUser(userId);

    if ((user.premium_limit - user.downloads_today) <= 0) {
      let messageText = T('limitReached') || '🚫 Лимит исчерпан.';
      const extra = { parse_mode: 'Markdown' };
      if (!user.subscribed_bonus_used) {
        messageText += `\n\n🎁 **Бонус!**\nПодпишись на @SCM_BLOG и получи 7 дней Plus бесплатно!`;
        extra.reply_markup = { inline_keyboard: [[{ text: '✅ Я подписался!', callback_data: 'check_subscription' }]] };
      }
      if (processingMessage) await bot.telegram.deleteMessage(userId, processingMessage.message_id).catch(() => {});
      return await safeSendMessage(userId, messageText, extra);
    }

    const { tracks, isPlaylist } = await getTracksInfo(url);
    const limitedTracks = applyUserLimits(tracks, user, isPlaylist);
    const tasksToDownload = await sendCachedTracks(limitedTracks, userId);
    await queueRemainingTracks(tasksToDownload, userId, isPlaylist, url);

    if (processingMessage) await bot.telegram.deleteMessage(userId, processingMessage.message_id).catch(() => {});
  } catch (err) {
    console.error(`[Enqueue] Ошибка для ${userId}: ${err.message}`);
    await safeSendMessage(userId, `❌ Ошибка: ${getYtdlErrorMessage(err)}`);
    if (processingMessage) await bot.telegram.deleteMessage(userId, processingMessage.message_id).catch(() => {});
  }
}