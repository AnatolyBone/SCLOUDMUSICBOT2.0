// src/services/lyricsService.js
import axios from 'axios';

export async function getLyrics(artist, title) {
    try {
        // 1. Чистим название от мусора
        const cleanTitle = title
            .replace(/\(Instrumental\)/gi, '')
            .replace(/\(Minus\)/gi, '')
            .replace(/\(Karaoke\)/gi, '')
            .replace(/Karaoke/gi, '')
            .trim();

        const query = `${artist} ${cleanTitle}`;
        console.log(`[Lyrics] Searching Lrclib for: ${query}`);

        // 2. Делаем запрос к легкому API
        const response = await axios.get(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`);

        // 3. Проверяем результаты
        if (!response.data || response.data.length === 0) {
            console.log('[Lyrics] Not found');
            return null;
        }

        // Берем первый результат
        const song = response.data[0];

        // Если текста нет, ищем дальше
        if (!song.plainLyrics) {
            return null;
        }

        return {
            text: song.plainLyrics, // Обычный текст
            title: song.trackName,
            artist: song.artistName,
            // Этот сервис не отдает обложки, но это не страшно, главное текст
            image: null, 
            url: null
        };

    } catch (e) {
        console.error('[Lyrics] Error:', e.message);
        return null;
    }
}
