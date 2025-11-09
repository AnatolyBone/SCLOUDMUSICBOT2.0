// services/spotifyManager.js (ФИНАЛЬНАЯ ВЕРСИЯ)

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { SPOTIPY_CLIENT_ID, SPOTIPY_CLIENT_SECRET } from '../config.js';
import { downloadQueue } from './downloadManager.js';
import { logEvent, getUser } from '../db.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(path.dirname(__filename));

async function ensureDirectoryExists(dirPath) {
    try { 
        await fs.access(dirPath); 
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.mkdir(dirPath, { recursive: true });
        } else {
            throw error;
        }
    }
}

export async function spotifyEnqueue(ctx, userId, url) {
    let statusMessage = null;
    let tempFilePath = null;
    
    try {
        // Проверяем, что Spotify credentials настроены
        if (!SPOTIPY_CLIENT_ID || !SPOTIPY_CLIENT_SECRET) {
            console.error('[Spotify] Spotify credentials не настроены');
            return await ctx.reply('❌ Spotify не настроен. Обратитесь к администратору.');
        }
        
        statusMessage = await ctx.reply('🔍 Анализирую ссылку Spotify...');
        
        const uploadDir = path.join(__dirname, 'uploads');
        await ensureDirectoryExists(uploadDir);
        
        const tempFileName = `spotify_${userId}_${Date.now()}.spotdl`;
        tempFilePath = path.join(uploadDir, tempFileName);
        
        // Используем системную команду spotdl с credentials в environment
        const env = {
            ...process.env,
            SPOTIPY_CLIENT_ID,
            SPOTIPY_CLIENT_SECRET
        };
        
        const command = `spotdl save "${url}" --save-file "${tempFilePath}"`;
        console.log(`[Spotify] Выполняю команду для ${userId}: spotdl save [url]`);
        
        try {
            const { stdout, stderr } = await execAsync(command, { env });
            if (stderr && !stderr.includes('WARNING')) {
                console.warn('[Spotify] Предупреждения spotdl:', stderr);
            }
        } catch (execError) {
            console.error('[Spotify] Ошибка выполнения spotdl:', execError);
            throw new Error('Не удалось получить информацию о треках');
        }
        
        // Читаем и парсим результат
        const fileContent = await fs.readFile(tempFilePath, 'utf-8');
        const tracksMeta = JSON.parse(fileContent);
        
        if (!tracksMeta || tracksMeta.length === 0) {
            return await ctx.telegram.editMessageText(
                ctx.chat.id, 
                statusMessage.message_id, 
                undefined, 
                '❌ Не удалось найти треки по этой ссылке Spotify.'
            );
        }
        
        const trackCount = tracksMeta.length;
        const isPlaylist = trackCount > 1;
        
        await ctx.telegram.editMessageText(
            ctx.chat.id, 
            statusMessage.message_id, 
            undefined, 
            `✅ Найдено треков: ${trackCount}. Добавляю в очередь...`
        );
        
        // Логируем событие
        await logEvent(userId, isPlaylist ? 'spotify_playlist_album' : 'spotify_track');
        
        // Получаем приоритет пользователя
        const user = await getUser(userId);
        const priority = user ? (user.premium_limit || 5) : 5;

        // Добавляем треки в очередь
        for (const track of tracksMeta) {
            // Формируем поисковый запрос для YouTube
            const artists = Array.isArray(track.artists) ? track.artists.join(' ') : track.artist || '';
            const searchQuery = `${artists} ${track.name}`.trim();
            
            const task = {
                userId,
                source: 'spotify',
                url: `ytsearch1:${searchQuery}`, // YouTube поиск
                originalUrl: track.url || url,
                metadata: {
                    title: track.name || 'Unknown Track',
                    uploader: artists || 'Unknown Artist',
                    duration: track.duration ? Math.round(track.duration / 1000) : undefined,
                    thumbnail: track.cover_url || track.thumbnail,
                    id: track.song_id || track.id || `spotify_${Date.now()}_${Math.random()}`
                },
                priority
            };
            
            console.log(`[Spotify] Добавляю в очередь: "${task.metadata.title}" by ${task.metadata.uploader}`);
            downloadQueue.add(task);
        }
        
        // Финальное сообщение
        const finalMessage = isPlaylist 
            ? `🎵 ${trackCount} треков из Spotify добавлены в очередь загрузки!`
            : `🎵 Трек из Spotify добавлен в очередь загрузки!`;
            
        await ctx.telegram.editMessageText(
            ctx.chat.id, 
            statusMessage.message_id, 
            undefined, 
            finalMessage
        );
        
    } catch (error) {
        console.error(`[Spotify] Ошибка для ${userId} с URL ${url}:`, error);
        
        const errorMessage = error.message || 'Неизвестная ошибка';
        
        if (statusMessage) {
            await ctx.telegram.editMessageText(
                ctx.chat.id, 
                statusMessage.message_id, 
                undefined, 
                `❌ Произошла ошибка: ${errorMessage}`
            ).catch(() => {});
        } else {
            await ctx.reply(`❌ Произошла ошибка: ${errorMessage}`);
        }
    } finally {
        // Удаляем временный файл
        if (tempFilePath) {
            try {
                await fs.unlink(tempFilePath);
                console.log(`[Spotify] Удален временный файл: ${tempFilePath}`);
            } catch (e) {
                console.error(`[Spotify] Не удалось удалить временный файл ${tempFilePath}:`, e);
            }
        }
    }
}