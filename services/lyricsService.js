// src/services/lyricsService.js
import axios from 'axios';
import * as cheerio from 'cheerio'; // Библиотека для парсинга HTML

// Получаем токен
const GENIUS_TOKEN = process.env.GENIUS_ACCESS_TOKEN;

export async function getLyrics(artist, title) {
    try {
        if (!GENIUS_TOKEN) throw new Error('Genius Token not set');

        // 1. Поиск песни через API
        const query = `${artist} ${title}`
            .replace(/\(Instrumental\)/gi, '')
            .replace(/\(Minus\)/gi, '')
            .replace(/\(Karaoke\)/gi, '')
            .trim();

        const searchUrl = `https://api.genius.com/search?q=${encodeURIComponent(query)}`;
        
        const searchRes = await axios.get(searchUrl, {
            headers: { 'Authorization': `Bearer ${GENIUS_TOKEN}` }
        });

        const hits = searchRes.data?.response?.hits;
        if (!hits || hits.length === 0) return null;

        const song = hits[0].result;
        const songUrl = song.url;

        // 2. Парсинг текста со страницы (Genius API не отдает сам текст, только ссылку)
        // Мы идем на страницу и берем текст оттуда.
        const pageRes = await axios.get(songUrl);
        const $ = cheerio.load(pageRes.data);

        // Genius часто меняет классы, поэтому пробуем разные селекторы
        let lyrics = $('div[class*="Lyrics__Container"]').text(); 
        
        // Если новый дизайн не сработал, пробуем старый
        if (!lyrics) {
            lyrics = $('.lyrics').text();
        }

        // Чистим текст (добавляем переносы строк, где они склеились)
        // Cheerio .text() склеивает блоки, поэтому нужно аккуратно форматировать.
        // Но для простоты пока вернем как есть, или используем спец. трюк:
        $('br').replaceWith('\n');
        lyrics = $('div[class*="Lyrics__Container"]').text();

        if (!lyrics) return null;

        return {
            text: lyrics.trim(),
            title: song.title,
            artist: song.primary_artist.name,
            image: song.song_art_image_thumbnail_url,
            url: songUrl
        };

    } catch (e) {
        console.error('[Lyrics] Manual Fetch Error:', e.message);
        return null;
    }
}
