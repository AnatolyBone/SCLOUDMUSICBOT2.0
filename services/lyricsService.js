// src/services/lyricsService.js
import axios from 'axios';
import * as cheerio from 'cheerio';

const GENIUS_TOKEN = process.env.GENIUS_ACCESS_TOKEN;

export async function getLyrics(artist, title) {
    try {
        if (!GENIUS_TOKEN) throw new Error('Genius Token not set');

        // 1. Чистим запрос
        const query = `${artist} ${title}`
            .replace(/\(Instrumental\)/gi, '')
            .replace(/\(Minus\)/gi, '')
            .replace(/\(Karaoke\)/gi, '')
            .trim();

        console.log(`[Lyrics] Searching for: ${query}`);

        // 2. Ищем песню через API
        // ВАЖНО: Добавляем User-Agent, чтобы Genius не блокировал
        const searchRes = await axios.get(`https://api.genius.com/search?q=${encodeURIComponent(query)}`, {
            headers: { 
                'Authorization': `Bearer ${GENIUS_TOKEN}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        const hits = searchRes.data?.response?.hits;
        if (!hits || hits.length === 0) {
            console.log('[Lyrics] No hits found');
            return null;
        }

        const song = hits[0].result;
        const songUrl = song.url;
        console.log(`[Lyrics] Found: ${song.full_title} (${songUrl})`);

        // 3. Парсим страницу с текстом
        const pageRes = await axios.get(songUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        const $ = cheerio.load(pageRes.data);

        // Пытаемся найти контейнеры с текстом
        let lyrics = '';
        
        // Новый дизайн Genius (несколько контейнеров)
        $('div[data-lyrics-container="true"]').each((i, elem) => {
            // Заменяем <br> на переносы строк перед получением текста
            $(elem).find('br').replaceWith('\n');
            lyrics += $(elem).text() + '\n\n';
        });

        // Старый дизайн (на всякий случай)
        if (!lyrics.trim()) {
            $('.lyrics').find('br').replaceWith('\n');
            lyrics = $('.lyrics').text();
        }

        if (!lyrics.trim()) return null;

        return {
            text: lyrics.trim(),
            title: song.title,
            artist: song.primary_artist.name,
            image: song.song_art_image_thumbnail_url,
            url: songUrl
        };

    } catch (e) {
        console.error(`[Lyrics] Manual Fetch Error: ${e.message}`);
        return null;
    }
}
