// services/youtubeManager.js - YouTube/YouTube Music для Render Free Tier

import ytdl from 'youtube-dl-exec';
import { PROXY_URL, ADMIN_ID } from '../config.js';

async function ytdlWithFallback(url, flags) {
  try {
    return await ytdl(url, flags);
  } catch (err) {
    const errText = err.stderr || err.message || '';
    if (flags.proxy && (errText.includes('Unable to connect to proxy') || errText.includes('ProxyError') || errText.includes('Tunnel connection failed') || errText.includes('Failed to establish a new connection'))) {
      console.warn(`[YouTubeManager] Прокси (${flags.proxy}) недоступен. Пробую без прокси... Ошибка:`, errText.slice(0, 200));
      const flagsCopy = { ...flags };
      delete flagsCopy.proxy;
      return await ytdl(url, flagsCopy);
    }
    throw err;
  }
}
import { downloadQueue } from './downloadManager.js';
import { getUser } from '../db.js';

// ========================= QUALITY PRESETS =========================

export const YOUTUBE_QUALITY_PRESETS = {
  low: { label: '🔉 128 kbps', bitrate: '128K' },
  medium: { label: '🔊 192 kbps', bitrate: '192K' },
  high: { label: '🎧 320 kbps', bitrate: '320K' }
};

const YTDL_COMMON = {
  'no-warnings': true,
  'no-playlist': true,
  proxy: PROXY_URL || undefined
};

// ========================= URL PARSING =========================

export function isYouTubeUrl(url) {
  return /youtube\.com|youtu\.be|music\.youtube\.com/.test(url);
}

// ========================= METADATA =========================

async function getYouTubeMetadata(url) {
  try {
    const info = await ytdlWithFallback(url, {
      'dump-single-json': true,
      'flat-playlist': true,
      ...YTDL_COMMON
    });
    return info;
  } catch (e) {
    console.error('[YouTube] Metadata error:', e.message);
    return null;
  }
}

// ========================= SESSION MANAGEMENT =========================

const youtubeSessions = new Map();

function cleanupOldSessions() {
  const now = Date.now();
  for (const [id, session] of youtubeSessions) {
    if (now - session.createdAt > 600000) youtubeSessions.delete(id);
  }
}

function formatDuration(seconds) {
  if (!seconds) return 'N/A';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ========================= MAIN HANDLERS =========================

export async function handleYouTubeUrl(ctx, url) {
  let statusMessage = null;
  
  try {
    // Ранняя проверка лимитов (для всех, кроме админа)
    const isAdmin = Number(ctx.from.id) === Number(ADMIN_ID);
    if (!isAdmin) {
      const user = await getUser(ctx.from.id);
      const remainingLimit = (user.premium_limit || 5) - (user.downloads_today || 0);
      if (remainingLimit <= 0) {
        return await ctx.reply('🚫 Дневной лимит загрузок исчерпан.');
      }
    }

    statusMessage = await ctx.reply('🔍 Анализирую YouTube ссылку...');
    
    const metadata = await getYouTubeMetadata(url);
    
    if (!metadata) {
      return await ctx.telegram.editMessageText(
        ctx.chat.id, statusMessage.message_id, undefined,
        '❌ Не удалось получить информацию о видео.'
      );
    }
    
    const user = await getUser(ctx.from.id);
    const remainingLimit = isAdmin ? 99999 : (user.premium_limit || 5) - (user.downloads_today || 0);
    
    if (remainingLimit <= 0) {
      return await ctx.telegram.editMessageText(
        ctx.chat.id, statusMessage.message_id, undefined,
        '🚫 Дневной лимит загрузок исчерпан.'
      );
    }
    
    const sessionId = `yt_${Date.now()}_${ctx.from.id}`;
    youtubeSessions.set(sessionId, {
      metadata,
      url,
      userId: ctx.from.id,
      createdAt: Date.now()
    });
    
    cleanupOldSessions();
    
    const isMusic = url.includes('music.youtube.com');
    const icon = isMusic ? '🎵' : '🎬';
    
    if (metadata.entries && metadata.entries.length > 0) {
      // Плейлист
      const count = Math.min(metadata.entries.length, remainingLimit);
      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMessage.message_id, undefined,
        `📀 <b>${metadata.title || 'Плейлист'}</b>\n\n` +
        `🎵 Треков: <b>${metadata.entries.length}</b>\n` +
        `📥 Доступно: <b>${count}</b>\n\n` +
        `Выберите качество:`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🔉 128 kbps', callback_data: `ytq:${sessionId}:low` },
                { text: '🔊 192 kbps', callback_data: `ytq:${sessionId}:medium` }
              ],
              [{ text: '🎧 320 kbps', callback_data: `ytq:${sessionId}:high` }],
              [{ text: '❌ Отмена', callback_data: `ytq:${sessionId}:cancel` }]
            ]
          }
        }
      );
    } else {
      // Одиночное видео
      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMessage.message_id, undefined,
        `${icon} <b>${metadata.title}</b>\n` +
        `👤 ${metadata.uploader || metadata.channel || 'Unknown'}\n` +
        `⏱ ${formatDuration(metadata.duration)}\n\n` +
        `Выберите качество аудио:`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🔉 128 kbps', callback_data: `ytq:${sessionId}:low` },
                { text: '🔊 192 kbps', callback_data: `ytq:${sessionId}:medium` }
              ],
              [{ text: '🎧 320 kbps', callback_data: `ytq:${sessionId}:high` }],
              [{ text: '❌ Отмена', callback_data: `ytq:${sessionId}:cancel` }]
            ]
          }
        }
      );
    }
    
  } catch (error) {
    console.error('[YouTube] handleYouTubeUrl error:', error);
    const msg = '❌ Ошибка при обработке YouTube ссылки.';
    if (statusMessage) {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, msg).catch(() => {});
    } else {
      await ctx.reply(msg);
    }
  }
}

export async function handleYouTubeQualitySelection(ctx, sessionId, quality) {
  const session = youtubeSessions.get(sessionId);
  
  if (!session) {
    return await ctx.answerCbQuery('❌ Сессия истекла.', { show_alert: true });
  }
  
  if (quality === 'cancel') {
    youtubeSessions.delete(sessionId);
    await ctx.deleteMessage().catch(() => {});
    return await ctx.answerCbQuery('Отменено');
  }
  
  await ctx.answerCbQuery(`Качество: ${YOUTUBE_QUALITY_PRESETS[quality]?.label || quality}`);
  
  const { metadata, url, userId } = session;
  const user = await getUser(userId);
  const isAdmin = Number(userId) === Number(ADMIN_ID);
  const remainingLimit = isAdmin ? 99999 : (user.premium_limit || 5) - (user.downloads_today || 0);
  
  if (remainingLimit <= 0) {
    return ctx.editMessageText('🚫 Дневной лимит загрузок исчерпан.');
  }
  
  if (metadata.entries && metadata.entries.length > 0) {
    // Плейлист
    const tracks = metadata.entries.slice(0, remainingLimit);
    
    await ctx.editMessageText(
      `⏳ Добавляю ${tracks.length} трек(ов) в очередь...\n` +
      `Качество: ${YOUTUBE_QUALITY_PRESETS[quality]?.label}`
    );
    
    for (const entry of tracks) {
      downloadQueue.add({
        userId,
        source: 'youtube',
        url: entry.url || `https://youtube.com/watch?v=${entry.id}`,
        quality,
        metadata: {
          title: entry.title,
          uploader: entry.uploader || entry.channel,
          duration: entry.duration,
          thumbnail: entry.thumbnail
        },
        priority: user.premium_limit || 5
      }).catch(err => {
        if (err.message === 'TASK_TIMEOUT') {
          console.error(`[TaskQueue] Задача отменена по таймауту: ${entry.title}`);
        } else {
          console.error('[TaskQueue] Ошибка выполнения задачи:', err.message);
        }
      });
    }
    
    await ctx.editMessageText(
      `✅ ${tracks.length} трек(ов) добавлено!\n` +
      `Качество: ${YOUTUBE_QUALITY_PRESETS[quality]?.label}`
    );
  } else {
    // Одиночное видео
    await ctx.editMessageText(
      `⏳ Добавляю в очередь...\n` +
      `Качество: ${YOUTUBE_QUALITY_PRESETS[quality]?.label}`
    );
    
    downloadQueue.add({
      userId,
      source: 'youtube',
      url,
      quality,
      metadata: {
        title: metadata.title,
        uploader: metadata.uploader || metadata.channel,
        duration: metadata.duration,
        thumbnail: metadata.thumbnail
      },
      priority: user.premium_limit || 5
    }).catch(err => {
      if (err.message === 'TASK_TIMEOUT') {
        console.error(`[TaskQueue] Задача отменена по таймауту: ${metadata.title}`);
      } else {
        console.error('[TaskQueue] Ошибка выполнения задачи:', err.message);
      }
    });
    
    await ctx.editMessageText(
      `✅ Трек добавлен в очередь!\n` +
      `Качество: ${YOUTUBE_QUALITY_PRESETS[quality]?.label}`
    );
  }
  
  youtubeSessions.delete(sessionId);
}
