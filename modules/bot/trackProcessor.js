import ytdl from 'youtube-dl-exec';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { enqueue, processNextInQueue } from '../queue/downloadQueue.js';
import { incrementDownloads, resetDailyLimitIfNeeded, saveTrackForUser } from '../db/trackRepository.js';
import { getUser, updateUserField } from '../db/userRepository.js';
import { logDownload, logEvent } from '../db/logRepository.js';
import { safeTelegramCall } from '../utils/telegramUtils.js';
import { sanitizeFilename } from '../utils/fileUtils.js';
import { resolveRedirect } from '../utils/networkUtils.js';
import { texts, sendAudioSafe } from './botUtils.js';
import NodeID3 from 'node-id3';
import util from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cacheDir = path.join(__dirname, '../../cache');

const writeID3 = util.promisify(NodeID3.write);

export { enqueue }; // Экспортируем enqueue из downloadQueue

// Переопределяем processNextInQueue для обработки треков
// Эта функция будет вызываться из downloadQueue.js
export async function processTrackByUrl(ctx, userId, url) {
  let user;
  try {
    user = await getUser(userId);
    if (!user) {
      console.error(`Пользователь ${userId} не найден.`);
      await ctx.telegram.sendMessage(userId, 'Произошла ошибка: пользователь не найден.');
      return;
    }

    await resetDailyLimitIfNeeded(userId);

    if (user.downloads_today >= user.premium_limit) {
      await ctx.telegram.sendMessage(userId, texts.limitReached);
      await logEvent(userId, 'limit_reached');
      return;
    }

    await logEvent(userId, 'download_started', { url });
    await ctx.telegram.sendMessage(userId, texts.downloading);

    const resolvedUrl = await resolveRedirect(url);

    const info = await ytdl(resolvedUrl, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      callHome: false,
      preferFreeFormats: true,
      youtubeSkipDashManifest: true,
      referer: resolvedUrl,
    });

    const title = sanitizeFilename(info.title || 'audio');
    const filePath = path.join(cacheDir, `${title}.mp3`);

    await ytdl(resolvedUrl, {
      output: filePath,
      extractAudio: true,
      audioFormat: 'mp3',
      noCheckCertificates: true,
      noWarnings: true,
      callHome: false,
      preferFreeFormats: true,
      youtubeSkipDashManifest: true,
      referer: resolvedUrl,
    });

    // Добавляем ID3 теги
    await writeID3({
      title: info.title,
      artist: info.artist || info.uploader || 'Unknown',
      album: info.album || 'SoundCloud',
      year: info.upload_date ? info.upload_date.substring(0, 4) : '',
      comment: { text: `Downloaded from SoundCloud via Telegram bot. Original URL: ${resolvedUrl}` }
    }, filePath);

    const fileId = await sendAudioSafe(ctx, userId, filePath, title);

    if (fileId) {
      await incrementDownloads(userId);
      await saveTrackForUser(userId, title, fileId);
      await logDownload(userId, title, fileId);
    } else {
      await ctx.telegram.sendMessage(userId, texts.error);
      await logEvent(userId, 'download_failed', { url, reason: 'send_audio_failed' });
    }

    fs.unlink(filePath, err => {
      if (err) console.error(`Ошибка удаления файла ${filePath}:`, err);
      else console.log(`🗑 Удалён файл: ${filePath}`);
    });
  } catch (e) {
    console.error(`Ошибка обработки трека для пользователя ${userId} (${url}):`, e);
    await ctx.telegram.sendMessage(userId, texts.error);
    await logEvent(userId, 'download_failed', { url, reason: e.message });
  }
}

// Переопределяем processNextInQueue в downloadQueue.js, чтобы она вызывала processTrackByUrl
// Это нужно сделать в downloadQueue.js, но для демонстрации здесь
// В реальном приложении downloadQueue.js должен импортировать processTrackByUrl
// и использовать ее в своей логике processNextInQueue
// Пример: downloadQueue.js
/*
import { processTrackByUrl } from '../bot/trackProcessor.js';

export async function processNextInQueue() {
  if (globalQueue.length === 0 || activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    return;
  }

  activeDownloads++;
  const { ctx, userId, url, resolve, reject } = globalQueue.shift();

  try {
    await ctx.reply(`⏳ Трек добавлен в очередь (#${globalQueue.length + 1})`);
    await processTrackByUrl(ctx, userId, url); // Вызов функции обработки трека
    resolve();
  } catch (error) {
    reject(error);
  } finally {
    activeDownloads--;
    processNextInQueue();
  }
}
*/
