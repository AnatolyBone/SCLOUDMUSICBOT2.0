// services/spotifyManager.js (ВЕРСИЯ ДЛЯ RENDER.COM)

import SpotifyWebApi from 'spotify-web-api-node';
import { SPOTIPY_CLIENT_ID, SPOTIPY_CLIENT_SECRET } from '../config.js';
import { downloadQueue } from './downloadManager.js';
import { logEvent, getUser } from '../db.js';

// Инициализация Spotify API
const spotifyApi = new SpotifyWebApi({
  clientId: SPOTIPY_CLIENT_ID,
  clientSecret: SPOTIPY_CLIENT_SECRET
});

// Функция для получения токена
async function getSpotifyToken() {
  try {
    const data = await spotifyApi.clientCredentialsGrant();
    spotifyApi.setAccessToken(data.body['access_token']);
    
    // Токен истекает через час, обновляем автоматически
    setTimeout(async () => {
      await getSpotifyToken();
    }, (data.body['expires_in'] - 60) * 1000);
    
    console.log('[Spotify] Токен получен успешно');
    return true;
  } catch (error) {
    console.error('[Spotify] Ошибка получения токена:', error);
    return false;
  }
}

// Инициализируем токен при запуске
getSpotifyToken();

// Парсим Spotify URL
function parseSpotifyUrl(url) {
  const match = url.match(/spotify\.com\/(track|album|playlist)\/([a-zA-Z0-9]+)/);
  if (!match) return null;
  return { type: match[1], id: match[2] };
}

// Получаем треки из плейлиста
async function getPlaylistTracks(playlistId) {
  const tracks = [];
  let offset = 0;
  const limit = 50;
  
  try {
    while (true) {
      const data = await spotifyApi.getPlaylistTracks(playlistId, {
        offset: offset,
        limit: limit,
        fields: 'items(track(name,artists,duration_ms,id,external_urls)),total'
      });
      
      const items = data.body.items;
      if (!items || items.length === 0) break;
      
      items.forEach(item => {
        if (item.track) {
          tracks.push({
            name: item.track.name,
            artists: item.track.artists.map(a => a.name),
            duration: item.track.duration_ms,
            id: item.track.id,
            url: item.track.external_urls?.spotify
          });
        }
      });
      
      if (items.length < limit) break;
      offset += limit;
    }
  } catch (error) {
    console.error('[Spotify] Ошибка получения плейлиста:', error);
  }
  
  return tracks;
}

// Получаем треки из альбома
async function getAlbumTracks(albumId) {
  try {
    const albumData = await spotifyApi.getAlbum(albumId);
    const album = albumData.body;
    
    return album.tracks.items.map(track => ({
      name: track.name,
      artists: track.artists.map(a => a.name),
      duration: track.duration_ms,
      id: track.id,
      url: track.external_urls?.spotify,
      album_name: album.name,
      album_image: album.images?.[0]?.url
    }));
  } catch (error) {
    console.error('[Spotify] Ошибка получения альбома:', error);
    return [];
  }
}

// Получаем один трек
async function getSingleTrack(trackId) {
  try {
    const data = await spotifyApi.getTrack(trackId);
    const track = data.body;
    
    return [{
      name: track.name,
      artists: track.artists.map(a => a.name),
      duration: track.duration_ms,
      id: track.id,
      url: track.external_urls?.spotify,
      album_image: track.album?.images?.[0]?.url
    }];
  } catch (error) {
    console.error('[Spotify] Ошибка получения трека:', error);
    return [];
  }
}

export async function spotifyEnqueue(ctx, userId, url) {
    let statusMessage = null;
    
    try {
      // Проверяем credentials
      if (!SPOTIPY_CLIENT_ID || !SPOTIPY_CLIENT_SECRET) {
        console.error('[Spotify] Credentials не настроены');
        return await ctx.reply('❌ Spotify не настроен. Обратитесь к администратору.');
      }
      
      // Парсим URL
      const parsed = parseSpotifyUrl(url);
      if (!parsed) {
        return await ctx.reply('❌ Неверная ссылка Spotify.');
      }
      
      statusMessage = await ctx.reply('🔍 Анализирую ссылку Spotify...');
      
      // ... остальной код
    // Обновляем токен если нужно
    if (!spotifyApi.getAccessToken()) {
      const tokenSuccess = await getSpotifyToken();
      if (!tokenSuccess) {
        throw new Error('Не удалось авторизоваться в Spotify');
      }
    }
    
    // Получаем треки в зависимости от типа
    let tracks = [];
    switch (parsed.type) {
      case 'track':
        tracks = await getSingleTrack(parsed.id);
        break;
      case 'album':
        tracks = await getAlbumTracks(parsed.id);
        break;
      case 'playlist':
        tracks = await getPlaylistTracks(parsed.id);
        break;
    }
    
    if (tracks.length === 0) {
      return await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMessage.message_id,
        undefined,
        '❌ Не удалось найти треки по этой ссылке.'
      );
    }
    
    // Проверяем лимиты пользователя
    const user = await getUser(userId);
    const remainingLimit = user.premium_limit - (user.downloads_today || 0);
    
    if (remainingLimit <= 0) {
      return await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMessage.message_id,
        undefined,
        '❌ Достигнут дневной лимит загрузок.'
      );
    }
    
    // Ограничиваем количество треков лимитом
    const tracksToProcess = tracks.slice(0, Math.min(tracks.length, remainingLimit));
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      undefined,
      `✅ Найдено треков: ${tracks.length}. Добавляю ${tracksToProcess.length} в очередь...`
    );
    
    // Логируем событие
    await logEvent(userId, tracks.length > 1 ? 'spotify_playlist_album' : 'spotify_track');
    
    // Получаем приоритет
    const priority = user ? (user.premium_limit || 5) : 5;
    
    // Добавляем треки в очередь
    // В spotifyManager.js, в цикле где добавляете треки в очередь
for (const track of tracksToProcess) {
  // Формируем поисковый запрос для YouTube
  const artists = Array.isArray(track.artists) ? track.artists.join(' ') : track.artist || '';
  const trackName = track.name || 'Unknown Track';
  const searchQuery = `${artists} ${trackName}`.trim(); // ОПРЕДЕЛЯЕМ searchQuery ЗДЕСЬ!
  
  const task = {
    userId,
    source: 'spotify',
    url: `ytsearch1:${searchQuery}`, // Теперь searchQuery определена
    originalUrl: track.url || url,
    metadata: {
      title: trackName,
      uploader: artists || 'Unknown Artist',
      duration: track.duration ? Math.round(track.duration / 1000) : undefined,
      thumbnail: track.cover_url || track.thumbnail || track.album_image,
      id: `spotify_${track.id || Date.now()}_${Math.random()}`,
      originalUrl: track.url || `https://open.spotify.com/track/${track.id}`
    },
    priority
  };
  
  console.log(`[Spotify] Добавляю в очередь: "${task.metadata.title}" by ${task.metadata.uploader}`);
  downloadQueue.add(task);
}
    
    // Финальное сообщение
    const finalMessage = tracksToProcess.length > 1 ?
      `🎵 ${tracksToProcess.length} треков добавлены в очередь!` :
      `🎵 Трек добавлен в очередь!`;
    
    if (tracksToProcess.length < tracks.length) {
      finalMessage += `\n⚠️ Остальные ${tracks.length - tracksToProcess.length} треков превышают ваш лимит.`;
    }
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      undefined,
      finalMessage
    );
    
  } catch (error) {
    console.error(`[Spotify] Ошибка для ${userId}:`, error);
    
    const errorMessage = '❌ Произошла ошибка при обработке Spotify ссылки.';
    
    if (statusMessage) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMessage.message_id,
        undefined,
        errorMessage
      ).catch(() => {});
    } else {
      await ctx.reply(errorMessage);
    }
  }
}