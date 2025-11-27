// src/services/lyricsService.js
import { Client } from "genius-lyrics";

const GENIUS_TOKEN = process.env.GENIUS_ACCESS_TOKEN;

// 1. Создаем клиент БЕЗ токена (чтобы избежать ошибки конструктора)
const client = new Client(); 

export async function getLyrics(artist, title) {
    try {
        const query = `${artist} ${title}`
            .replace(/\(Instrumental\)/gi, '')
            .replace(/\(Minus\)/gi, '')
            .replace(/\(Karaoke\)/gi, '')
            .trim();
        
        // 2. Передаем токен ПРЯМО В ЗАПРОС (apiKey)
        const searches = await client.songs.search(query, { 
            apiKey: GENIUS_TOKEN,
            optimizeQuery: true 
        });
        
        if (!searches || searches.length === 0) {
            return null;
        }

        const firstSong = searches[0];
        const lyrics = await firstSong.lyrics();
        
        if (!lyrics) return null;

        return {
            text: lyrics,
            title: firstSong.title,
            artist: firstSong.artist.name,
            image: firstSong.thumbnail,
            url: firstSong.url
        };
    } catch (e) {
        console.error('[Lyrics] Error:', e.message);
        return null;
    }
}
