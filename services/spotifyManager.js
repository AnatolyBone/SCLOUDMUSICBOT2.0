// services/spotifyManager.js

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { SPOTIPY_CLIENT_ID, SPOTIPY_CLIENT_SECRET } from '../config.js';
import { enqueue } from './downloadManager.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const UPLOAD_DIR = path.join(path.dirname(path.dirname(__filename)), 'uploads');

async function ensureDirectoryExists(dirPath) {
    try { await fs.access(dirPath); } catch { await fs.mkdir(dirPath, { recursive: true }); }
}

export async function spotifyEnqueue(ctx, userId, url) {
    let statusMessage = null;
    let tempFilePath = null;
    try {
        statusMessage = await ctx.reply('🔍 Анализирую ссылку Spotify...');
        await ensureDirectoryExists(UPLOAD_DIR);
        tempFilePath = path.join(UPLOAD_DIR, `spotify_${userId}_${Date.now()}.spotdl`);
        
        const command = `spotdl save "${url}" --save-file "${tempFilePath}"`;
        await execAsync(command, { env: { ...process.env, SPOTIPY_CLIENT_ID, SPOTIPY_CLIENT_SECRET } });
        
        const fileContent = await fs.readFile(tempFilePath, 'utf-8');
        const tracksMeta = JSON.parse(fileContent);

        if (!tracksMeta || tracksMeta.length === 0) {
            throw new Error('Не удалось найти треки по ссылке Spotify.');
        }
        
        await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, `✅ Найдено треков: ${tracksMeta.length}. Передаю на обработку...`);

        // Для каждого трека из Spotify мы создаем поисковый запрос для YouTube
        // и передаем его в вашу основную функцию `enqueue`
        for (const track of tracksMeta) {
            const searchQuery = `${track.artists.join(' ')} - ${track.name}`;
            // Вызываем вашу основную функцию enqueue
            enqueue(ctx, userId, searchQuery);
        }

    } catch (error) {
        console.error(`[Spotify Manager] Ошибка для ${userId}:`, error.stderr || error.message);
        const userMessage = '❌ Произошла ошибка при обработке ссылки Spotify. Возможно, трек недоступен.';
        if (statusMessage) {
            await ctx.telegram.editMessageText(ctx.chat.id, statusMessage.message_id, undefined, userMessage);
        } else {
             await ctx.reply(userMessage);
        }
    } finally {
        if (tempFilePath) {
            await fs.unlink(tempFilePath).catch(() => {});
        }
    }
}