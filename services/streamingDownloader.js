// services/streamingDownloader.js
import { spawn } from 'child_process';
import { PassThrough } from 'stream';
import ffmpegPath from 'ffmpeg-static';
import { bot } from '../bot.js';

/**
 * 🚀 STREAMING DOWNLOAD (БЕЗ ДИСКА!)
 * Работает так же, как Python scdlbot
 */
export async function downloadAndStreamTrack(userId, url, metadata) {
  return new Promise((resolve, reject) => {
    console.log(`[Stream] 🚀 Старт стриминга: ${metadata.title}`);
    
    // 1. Запускаем yt-dlp с выводом в stdout
    const ytdlp = spawn('yt-dlp', [
      url,
      '-f', 'bestaudio',
      '-o', '-', // 👈 ВЫВОДИМ В STDOUT!
      '--no-playlist',
      '--extractor-args', 'soundcloud:player_client_id=CLIENT_ID',
      '--quiet'
    ]);
    
    // 2. Конвертируем в MP3 на лету через ffmpeg
    const ffmpeg = spawn(ffmpegPath, [
      '-i', 'pipe:0', // Читаем из stdin
      '-vn', // Без видео
      '-acodec', 'libmp3lame',
      '-b:a', '320k',
      '-f', 'mp3',
      '-', // 👈 ВЫВОДИМ В STDOUT!
    ]);
    
    // 3. Соединяем: yt-dlp → ffmpeg
    ytdlp.stdout.pipe(ffmpeg.stdin);
    
    // 4. Обрабатываем ошибки
    let hasError = false;
    
    ytdlp.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('ERROR')) {
        console.error('[yt-dlp ERROR]:', msg);
        hasError = true;
      }
    });
    
    ffmpeg.stderr.on('data', (data) => {
      // ffmpeg пишет прогресс в stderr - это нормально
      // console.log('[ffmpeg]:', data.toString());
    });
    
    ytdlp.on('error', (err) => {
      hasError = true;
      reject(new Error(`yt-dlp: ${err.message}`));
    });
    
    ffmpeg.on('error', (err) => {
      hasError = true;
      reject(new Error(`ffmpeg: ${err.message}`));
    });
    
    // 5. Отправляем stream в Telegram СРАЗУ!
    const filename = `${metadata.title.replace(/[^a-zA-Z0-9]/g, '_')}.mp3`;
    
    bot.telegram.sendAudio(
      userId,
      {
        source: ffmpeg.stdout, // 👈 STREAM НАПРЯМУЮ!
        filename: filename
      },
      {
        title: metadata.title,
        performer: metadata.uploader || 'Unknown',
        duration: metadata.duration ? Math.round(metadata.duration) : undefined
      }
    )
    .then((sentMsg) => {
      if (hasError) {
        return reject(new Error('Stream failed'));
      }
      
      console.log(`[Stream] ✅ Успех: ${metadata.title}`);
      resolve({
        success: true,
        fileId: sentMsg.audio.file_id
      });
    })
    .catch((err) => {
      // Убиваем процессы при ошибке Telegram API
      ytdlp.kill();
      ffmpeg.kill();
      reject(err);
    });
    
    // 6. Таймаут на случай зависания
    setTimeout(() => {
      if (!hasError) {
        ytdlp.kill();
        ffmpeg.kill();
        reject(new Error('TIMEOUT'));
      }
    }, 120000); // 2 минуты
  });
}