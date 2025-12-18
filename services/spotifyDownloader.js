// services/spotifyDownloader.js
// Надёжный загрузчик Spotify через YouTube matching

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

const TEMP_DIR = path.join(os.tmpdir(), 'spotify-dl');
const COOKIES_PATH = path.join(process.cwd(), 'youtube_cookies.txt');

// Создаём папку если нет
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Скачивает трек по поисковому запросу через yt-dlp
 * @param {string} searchQuery - "Artist - Title"
 * @param {object} options - { quality: 'high'|'medium'|'low', metadata: {...} }
 * @returns {Promise<{filePath: string, duration: number}>}
 */
export async function downloadFromYouTube(searchQuery, options = {}) {
  const { quality = 'high', metadata = {} } = options;
  
  const baseName = `spotify_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const outputPath = path.join(TEMP_DIR, `${baseName}.mp3`);
  
  // Битрейт в зависимости от качества
  const bitrate = {
    'high': '320k',
    'medium': '192k',
    'low': '128k'
  }[quality] || '192k';

  console.log(`[SpotifyDL] 🔍 Ищу: "${searchQuery}"`);
  console.log(`[SpotifyDL] 📁 Output: ${outputPath}`);
  console.log(`[SpotifyDL] 🎵 Quality: ${bitrate}`);

  return new Promise((resolve, reject) => {
    // Аргументы yt-dlp - минимальный надёжный набор
    const args = [
      '-m', 'yt_dlp',
      
      // Поиск на YouTube
      `ytsearch1:${searchQuery}`,
      
      // Формат: пробуем разные варианты
      '-f', 'bestaudio/best',
      
      // Извлекаем аудио и конвертируем в mp3
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', bitrate,
      
      // Выходной файл
      '-o', outputPath,
      
      // Базовые опции
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--geo-bypass',
      
      // FFmpeg
      '--ffmpeg-location', ffmpegPath,
      
      // Ретраи
      '--retries', '3',
      '--fragment-retries', '3',
      
      // Без прогресса в логах (чище)
      '--progress',
      '--newline',
    ];
    
    // Куки если есть
    if (fs.existsSync(COOKIES_PATH)) {
      args.push('--cookies', COOKIES_PATH);
    }

    console.log(`[SpotifyDL] 🚀 Запуск yt-dlp...`);
    
    const proc = spawn('python3', args, {
      cwd: TEMP_DIR,
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const line = data.toString().trim();
      stdout += line + '\n';
      
      // Показываем прогресс
      if (line.includes('%')) {
        const match = line.match(/(\d+\.?\d*)%/);
        if (match) {
          process.stdout.write(`\r[SpotifyDL] ⬇️  ${match[1]}%`);
        }
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      console.log(''); // Новая строка после прогресса
      
      if (code !== 0) {
        console.error(`[SpotifyDL] ❌ yt-dlp код: ${code}`);
        console.error(`[SpotifyDL] stderr: ${stderr.slice(-500)}`);
        
        // Пробуем понять ошибку
        if (stderr.includes('Requested format is not available')) {
          return reject(new Error('FORMAT_UNAVAILABLE'));
        }
        if (stderr.includes('Video unavailable') || stderr.includes('Private video')) {
          return reject(new Error('VIDEO_UNAVAILABLE'));
        }
        if (stderr.includes('Sign in')) {
          return reject(new Error('AUTH_REQUIRED'));
        }
        
        return reject(new Error(`yt-dlp failed: ${stderr.slice(-200)}`));
      }

      // Проверяем файл
      if (!fs.existsSync(outputPath)) {
        // Ищем файл с другим расширением
        const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(baseName));
        if (files.length > 0) {
          const foundPath = path.join(TEMP_DIR, files[0]);
          console.log(`[SpotifyDL] ✅ Найден файл: ${files[0]}`);
          const stats = fs.statSync(foundPath);
          return resolve({
            filePath: foundPath,
            size: stats.size,
            duration: metadata.duration || null
          });
        }
        
        console.error(`[SpotifyDL] ❌ Файл не создан!`);
        console.error(`[SpotifyDL] TEMP_DIR содержит: ${fs.readdirSync(TEMP_DIR).join(', ')}`);
        return reject(new Error('FILE_NOT_CREATED'));
      }

      const stats = fs.statSync(outputPath);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      
      console.log(`[SpotifyDL] ✅ Скачано: ${sizeMB} MB`);
      
      resolve({
        filePath: outputPath,
        size: stats.size,
        duration: metadata.duration || null
      });
    });

    proc.on('error', (err) => {
      console.error(`[SpotifyDL] ❌ Spawn error:`, err);
      reject(new Error(`Spawn failed: ${err.message}`));
    });
  });
}

/**
 * Альтернативный метод - если первый не сработал
 * Использует другой формат и fallback на видео
 */
export async function downloadFromYouTubeFallback(searchQuery, options = {}) {
  const { quality = 'medium' } = options;
  
  const baseName = `spotify_fb_${Date.now()}`;
  const outputTemplate = path.join(TEMP_DIR, `${baseName}.%(ext)s`);
  
  console.log(`[SpotifyDL/Fallback] 🔄 Пробуем альтернативный метод...`);

  return new Promise((resolve, reject) => {
    const args = [
      '-m', 'yt_dlp',
      `ytsearch1:${searchQuery}`,
      
      // Без указания формата - yt-dlp сам выберет лучший
      '-x',
      '--audio-format', 'mp3',
      '-o', outputTemplate,
      '--no-playlist',
      '--ffmpeg-location', ffmpegPath,
    ];
    
    if (fs.existsSync(COOKIES_PATH)) {
      args.push('--cookies', COOKIES_PATH);
    }

    const proc = spawn('python3', args, { cwd: TEMP_DIR });

    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Fallback failed: ${stderr.slice(-200)}`));
      }
      
      const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(baseName));
      if (files.length === 0) {
        return reject(new Error('Fallback: file not created'));
      }
      
      const filePath = path.join(TEMP_DIR, files[0]);
      console.log(`[SpotifyDL/Fallback] ✅ Скачано: ${filePath}`);
      
      resolve({ filePath, size: fs.statSync(filePath).size });
    });

    proc.on('error', reject);
  });
}

/**
 * Главная функция - пробует все методы
 */
export async function downloadSpotifyTrack(trackInfo, options = {}) {
  const searchQuery = `${trackInfo.artist} ${trackInfo.title}`;
  
  // Метод 1: Стандартный
  try {
    return await downloadFromYouTube(searchQuery, { 
      ...options, 
      metadata: trackInfo 
    });
  } catch (err) {
    console.warn(`[SpotifyDL] Метод 1 не сработал: ${err.message}`);
  }
  
  // Метод 2: Fallback без указания формата
  try {
    return await downloadFromYouTubeFallback(searchQuery, options);
  } catch (err) {
    console.warn(`[SpotifyDL] Метод 2 не сработал: ${err.message}`);
  }
  
  // Метод 3: Поиск только по названию
  try {
    console.log(`[SpotifyDL] Метод 3: только название...`);
    return await downloadFromYouTube(trackInfo.title, options);
  } catch (err) {
    console.error(`[SpotifyDL] Все методы провалились`);
    throw new Error(`Не удалось скачать: ${trackInfo.title}`);
  }
}

/**
 * Очистка старых файлов
 */
export function cleanupTempFiles(maxAgeMs = 30 * 60 * 1000) {
  try {
    const now = Date.now();
    const files = fs.readdirSync(TEMP_DIR);
    let deleted = 0;
    
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      const stats = fs.statSync(filePath);
      
      if (now - stats.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
        deleted++;
      }
    }
    
    if (deleted > 0) {
      console.log(`[SpotifyDL] 🧹 Удалено ${deleted} старых файлов`);
    }
  } catch (e) {
    console.warn('[SpotifyDL] Cleanup error:', e.message);
  }
}

// Автоочистка каждые 10 минут
setInterval(() => cleanupTempFiles(), 10 * 60 * 1000);

