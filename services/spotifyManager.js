// services/spotifyManager.js - Лёгкая версия для Render Free Tier
// Использует yt-dlp для поиска на YouTube вместо тяжёлого spotdl

import ytdl from 'youtube-dl-exec';
import { PROXY_URL } from '../config.js';
import { downloadQueue } from './downloadManager.js';
import { getUser } from '../db.js';

// ========================= QUALITY PRESETS =========================

export const QUALITY_PRESETS = {
  low: { label: '🔉 128 kbps', bitrate: '128K', format: 'mp3' },
  medium: { label: '🔊 192 kbps', bitrate: '192K', format: 'mp3' },
  high: { label: '🎧 320 kbps', bitrate: '320K', format: 'mp3' }
};

// Базовые опции yt-dlp
const YTDL_COMMON = {
  'no-warnings': true,
  'no-playlist': true,
  proxy: PROXY_URL || undefined
};

// ========================= SPOTIFY URL PARSING =========================

const SPOTIFY_PATTERNS = {
  track: /spotify\.com\/track\/([a-zA-Z0-9]+)/,
  album: /spotify\.com\/album\/([a-zA-Z0-9]+)/,
  playlist: /spotify\.com\/playlist\/([a-zA-Z0-9]+)/
};

function parseSpotifyUrl(url) {
  for (const [type, pattern] of Object.entries(SPOTIFY_PATTERNS)) {
    const match = url.match(pattern);
    if (match) return { type, id: match[1] };
  }
  return null;
}

// ========================= METADATA EXTRACTION =========================

/**
 * Получает метаданные Spotify трека через yt-dlp (он умеет парсить Spotify)
 */
async function getSpotifyTrackInfo(url) {
  try {
    const info = await ytdl(url, {
      'dump-single-json': true,
      'flat-playlist': true,
      ...YTDL_COMMON
    });
    
    if (info.entries) {
      // Плейлист/альбом
      return info.entries.map(entry => ({
        title: entry.title,
        artist: entry.artist || entry.uploader || 'Unknown',
        duration: entry.duration,
        thumbnail: entry.thumbnail,
        searchQuery: `${entry.artist || ''} ${entry.title}`.trim(),
        originalUrl: entry.url || url
      }));
    } else {
      // Одиночный трек
      return [{
        title: info.title,
        artist: info.artist || info.uploader || 'Unknown',
        duration: info.duration,
        thumbnail: info.thumbnail,
        searchQuery: `${info.artist || ''} ${info.title}`.trim(),
        originalUrl: url
      }];
    }
  } catch (e) {
    console.error('[Spotify] yt-dlp metadata error:', e.message);
    return null;
  }
}

// ========================= SESSION MANAGEMENT =========================

const spotifySessions = new Map();

function cleanupOldSessions() {
  const now = Date.now();
  const maxAge = 10 * 60 * 1000;
  for (const [id, session] of spotifySessions) {
    if (now - session.createdAt > maxAge) spotifySessions.delete(id);
  }
}

function formatDuration(seconds) {
  if (!seconds) return 'N/A';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ========================= MAIN HANDLERS =========================

/**
 * Обрабатывает Spotify ссылку - показывает меню выбора качества
 */
export async function handleSpotifyUrl(ctx, url) {
  let statusMessage = null;
  
  try {
    statusMessage = await ctx.reply('🔍 Анализирую ссылку Spotify...');
    
    const tracks = await getSpotifyTrackInfo(url);
    
    if (!tracks || tracks.length === 0) {
      return await ctx.telegram.editMessageText(
        ctx.chat.id, statusMessage.message_id, undefined,
        '❌ Не удалось получить информацию о треке.\n\nПопробуйте отправить название трека текстом для поиска.'
      );
    }
    
    // Проверяем лимиты
    const user = await getUser(ctx.from.id);
    const remainingLimit = (user.premium_limit || 5) - (user.downloads_today || 0);
    
    if (remainingLimit <= 0) {
      return await ctx.telegram.editMessageText(
        ctx.chat.id, statusMessage.message_id, undefined,
        '🚫 Дневной лимит загрузок исчерпан.'
      );
    }
    
    // Создаём сессию
    const sessionId = `sp_${Date.now()}_${ctx.from.id}`;
    spotifySessions.set(sessionId, {
      tracks,
      url,
      userId: ctx.from.id,
      createdAt: Date.now()
    });
    
    cleanupOldSessions();
    
    if (tracks.length === 1) {
      const track = tracks[0];
      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMessage.message_id, undefined,
        `🎵 <b>${track.title}</b>\n` +
        `👤 ${track.artist}\n` +
        `⏱ ${formatDuration(track.duration)}\n\n` +
        `Выберите качество:`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🔉 128 kbps', callback_data: `spq:${sessionId}:low` },
                { text: '🔊 192 kbps', callback_data: `spq:${sessionId}:medium` }
              ],
              [
                { text: '🎧 320 kbps', callback_data: `spq:${sessionId}:high` }
              ],
              [{ text: '❌ Отмена', callback_data: `spq:${sessionId}:cancel` }]
            ]
          }
        }
      );
    } else {
      const tracksToShow = Math.min(tracks.length, remainingLimit);
      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMessage.message_id, undefined,
        `📀 <b>Найден плейлист/альбом</b>\n\n` +
        `🎵 Треков: <b>${tracks.length}</b>\n` +
        `📥 Доступно: <b>${tracksToShow}</b>\n\n` +
        `Выберите качество:`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🔉 128 kbps', callback_data: `spq:${sessionId}:low` },
                { text: '🔊 192 kbps', callback_data: `spq:${sessionId}:medium` }
              ],
              [
                { text: '🎧 320 kbps', callback_data: `spq:${sessionId}:high` }
              ],
              [{ text: '❌ Отмена', callback_data: `spq:${sessionId}:cancel` }]
            ]
          }
        }
      );
    }
    
  } catch (error) {
    console.error('[Spotify] handleSpotifyUrl error:', error);
    const errorMsg = '❌ Ошибка при обработке Spotify ссылки.';
    if (statusMessage) {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, errorMsg).catch(() => {});
    } else {
      await ctx.reply(errorMsg);
    }
  }
}

/**
 * Обрабатывает выбор качества
 */
export async function handleQualitySelection(ctx, sessionId, quality) {
  const session = spotifySessions.get(sessionId);
  
  if (!session) {
    return await ctx.answerCbQuery('❌ Сессия истекла. Отправьте ссылку заново.', { show_alert: true });
  }
  
  if (quality === 'cancel') {
    spotifySessions.delete(sessionId);
    await ctx.deleteMessage().catch(() => {});
    return await ctx.answerCbQuery('Отменено');
  }
  
  await ctx.answerCbQuery(`Качество: ${QUALITY_PRESETS[quality]?.label || quality}`);
  
  const { tracks, userId } = session;
  const user = await getUser(userId);
  const remainingLimit = (user.premium_limit || 5) - (user.downloads_today || 0);
  const tracksToProcess = tracks.slice(0, Math.min(tracks.length, remainingLimit));
  
  await ctx.editMessageText(
    `⏳ Добавляю ${tracksToProcess.length} трек(ов) в очередь...\n` +
    `Качество: ${QUALITY_PRESETS[quality]?.label || quality}`
  );
  
  // Добавляем в очередь - ищем на YouTube
  for (const track of tracksToProcess) {
    const task = {
      userId,
      source: 'spotify',
      // Поиск на YouTube по названию
      url: `ytsearch1:${track.searchQuery}`,
      originalUrl: track.originalUrl,
      quality: quality,
      metadata: {
        title: track.title,
        uploader: track.artist,
        duration: track.duration,
        thumbnail: track.thumbnail
      },
      priority: user.premium_limit || 5
    };
    
    downloadQueue.add(task);
  }
  
  await ctx.editMessageText(
    `✅ ${tracksToProcess.length} трек(ов) добавлено в очередь!\n` +
    `Качество: ${QUALITY_PRESETS[quality]?.label || quality}`
  );
  
  spotifySessions.delete(sessionId);
}

// Legacy export
export async function spotifyEnqueue(ctx, userId, url) {
  return handleSpotifyUrl(ctx, url);
}
