// services/spotifyManager.js - Spotify через официальный API

import { SPOTIPY_CLIENT_ID, SPOTIPY_CLIENT_SECRET } from '../config.js';
import { downloadQueue } from './downloadManager.js';
import { getUser } from '../db.js';

// ========================= QUALITY PRESETS =========================

export const QUALITY_PRESETS = {
  low: { label: '🔉 128 kbps', bitrate: '128K', format: 'mp3' },
  medium: { label: '🔊 192 kbps', bitrate: '192K', format: 'mp3' },
  high: { label: '🎧 320 kbps', bitrate: '320K', format: 'mp3' }
};

// ========================= SPOTIFY API =========================

let spotifyToken = null;
let tokenExpiry = 0;

/**
 * Получает access token через Client Credentials Flow
 */
async function getSpotifyToken() {
  if (spotifyToken && Date.now() < tokenExpiry) {
    return spotifyToken;
  }
  
  const credentials = Buffer.from(`${SPOTIPY_CLIENT_ID}:${SPOTIPY_CLIENT_SECRET}`).toString('base64');
  
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  
  if (!response.ok) {
    throw new Error(`Spotify auth failed: ${response.status}`);
  }
  
  const data = await response.json();
  spotifyToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000; // Обновляем за минуту до истечения
  
  console.log('[Spotify] Token получен, истекает через', data.expires_in, 'сек');
  return spotifyToken;
}

/**
 * Делает запрос к Spotify API
 */
async function spotifyApi(endpoint) {
  const token = await getSpotifyToken();
  
  const response = await fetch(`https://api.spotify.com/v1${endpoint}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  
  if (!response.ok) {
    throw new Error(`Spotify API error: ${response.status}`);
  }
  
  return response.json();
}

// ========================= URL PARSING =========================

function parseSpotifyUrl(url) {
  const patterns = {
    track: /spotify\.com\/(?:intl-\w+\/)?track\/([a-zA-Z0-9]+)/,
    album: /spotify\.com\/(?:intl-\w+\/)?album\/([a-zA-Z0-9]+)/,
    playlist: /spotify\.com\/(?:intl-\w+\/)?playlist\/([a-zA-Z0-9]+)/
  };
  
  for (const [type, pattern] of Object.entries(patterns)) {
    const match = url.match(pattern);
    if (match) return { type, id: match[1] };
  }
  return null;
}

// ========================= METADATA EXTRACTION =========================

/**
 * Получает метаданные через Spotify API
 */
async function getSpotifyTrackInfo(url) {
  const parsed = parseSpotifyUrl(url);
  
  if (!parsed) {
    console.error('[Spotify] Не удалось распарсить URL:', url);
    return null;
  }
  
  try {
    if (parsed.type === 'track') {
      // Одиночный трек
      const track = await spotifyApi(`/tracks/${parsed.id}`);
      return [{
        title: track.name,
        artist: track.artists.map(a => a.name).join(', '),
        duration: Math.round(track.duration_ms / 1000),
        thumbnail: track.album?.images?.[0]?.url,
        searchQuery: `${track.artists[0]?.name} - ${track.name}`,
        originalUrl: url
      }];
      
    } else if (parsed.type === 'album') {
      // Альбом
      const album = await spotifyApi(`/albums/${parsed.id}`);
      return album.tracks.items.map(track => ({
        title: track.name,
        artist: track.artists.map(a => a.name).join(', '),
        duration: Math.round(track.duration_ms / 1000),
        thumbnail: album.images?.[0]?.url,
        searchQuery: `${track.artists[0]?.name} - ${track.name}`,
        originalUrl: track.external_urls?.spotify || url
      }));
      
    } else if (parsed.type === 'playlist') {
      // Плейлист
      const playlist = await spotifyApi(`/playlists/${parsed.id}?fields=name,tracks.items(track(name,artists,duration_ms,album(images),external_urls))`);
      return playlist.tracks.items
        .filter(item => item.track) // Иногда бывают null
        .map(item => ({
          title: item.track.name,
          artist: item.track.artists.map(a => a.name).join(', '),
          duration: Math.round(item.track.duration_ms / 1000),
          thumbnail: item.track.album?.images?.[0]?.url,
          searchQuery: `${item.track.artists[0]?.name} - ${item.track.name}`,
          originalUrl: item.track.external_urls?.spotify || url
        }));
    }
    
  } catch (e) {
    console.error('[Spotify] API error:', e.message);
    return null;
  }
  
  return null;
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
    // Проверяем наличие API ключей
    if (!SPOTIPY_CLIENT_ID || !SPOTIPY_CLIENT_SECRET) {
      return await ctx.reply('❌ Spotify API не настроен. Обратитесь к администратору.');
    }
    
    statusMessage = await ctx.reply('🔍 Получаю информацию из Spotify...');
    
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
        `📀 <b>Найдено треков: ${tracks.length}</b>\n\n` +
        `📥 Доступно для скачивания: <b>${tracksToShow}</b>\n\n` +
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
