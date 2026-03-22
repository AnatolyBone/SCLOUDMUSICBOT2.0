// =====================================================================================
//      DOWNLOAD MANAGER - ОПТИМИЗИРОВАН ДЛЯ RENDER FREE TIER
//      Приоритет: потоковая отправка (быстро, без записи на диск)
// =====================================================================================

import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { STORAGE_CHANNEL_ID, CHANNEL_USERNAME, PROXY_URL, SPOTIPY_CLIENT_ID, SPOTIPY_CLIENT_SECRET } from '../config.js';

// Логика определения пути к кукам:
// 1. Сначала ищем в секретах Render (/etc/secrets/cookies.txt)
// 2. Если нет, ищем в корне проекта (для локальной разработки)
let COOKIES_PATH = '/etc/secrets/cookies.txt';

if (!fs.existsSync(COOKIES_PATH)) {
    COOKIES_PATH = path.join(process.cwd(), 'cookies.txt');
}

// Копируем cookies во временную папку (доступную для записи) для использования в yt-dlp
let WRITABLE_COOKIES_PATH = null;
if (fs.existsSync(COOKIES_PATH)) {
    try {
        WRITABLE_COOKIES_PATH = path.join(os.tmpdir(), 'cookies.txt');
        fs.copyFileSync(COOKIES_PATH, WRITABLE_COOKIES_PATH);
        console.log('🍪 [Cookies] Файл найден и скопирован в:', WRITABLE_COOKIES_PATH);
    } catch (err) {
        console.warn('⚠️ [Cookies] Не удалось скопировать во временную папку:', err.message);
        // Используем оригинальный путь как fallback
        WRITABLE_COOKIES_PATH = COOKIES_PATH;
    }
} else {
    console.warn('⚠️ [Cookies] Файл НЕ найден!');
}
import { Markup } from 'telegraf';
import ffmpegPath from 'ffmpeg-static';
import scdl from 'soundcloud-downloader';
import os from 'os';
import { fileURLToPath } from 'url';
import ytdl from 'youtube-dl-exec';
import axios from 'axios';

/**
 * Форматирует секунды в mm:ss
 */
function formatDuration(seconds) {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

import { bot } from '../bot.js';
import { T } from '../config/texts.js';
import { TaskQueue } from '../lib/TaskQueue.js';
import * as db from '../db.js';
import { taskBroker } from './taskBroker.js';
import { getSetting } from './settingsManager.js';

// Папка для обложек
const THUMB_DIR = path.join(os.tmpdir(), 'sc-thumbs');
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

/**
 * Скачивает обложку и возвращает путь к файлу или null
 */
async function downloadThumbnail(thumbnailUrl) {
  if (!thumbnailUrl) return null;
  try {
    const thumbPath = path.join(THUMB_DIR, `thumb_${Date.now()}.jpg`);
    const response = await axios.get(thumbnailUrl, { responseType: 'arraybuffer', timeout: 10000 });
    fs.writeFileSync(thumbPath, response.data);
    return thumbPath;
  } catch (e) {
    console.warn('[Thumbnail] Не удалось скачать обложку:', e.message);
    return null;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Папка для временных файлов (нужна для yt-dlp fallback)
const TEMP_DIR = path.join(os.tmpdir(), 'sc-cache');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10) || 4;

// Настройки для yt-dlp
const YTDL_COMMON = {
  'format': 'bestaudio[ext=mp3]/bestaudio[ext=opus]/bestaudio',
  'ffmpeg-location': ffmpegPath,
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
  proxy: PROXY_URL,
  retries: 3,
  'socket-timeout': 120,
  'no-warnings': true,
};

// Базовые опции для получения метаданных/скачиваний через yt-dlp
const YTDL_OPTIONS = {
  ...YTDL_COMMON,
  'no-playlist': true,
  'ignore-errors': true
};

// ========================= QUALITY PRESETS =========================

export const QUALITY_PRESETS = {
  low: { bitrate: '128K', format: 'mp3', label: '128 kbps' },
  medium: { bitrate: '192K', format: 'mp3', label: '192 kbps' },
  high: { bitrate: '320K', format: 'mp3', label: '320 kbps' }
};

/**
 * Скачивает трек через spotdl (для Spotify)
 */
async function downloadWithSpotdl(url, quality = 'high') {
  const { spawn } = await import('child_process');
  const baseName = `spot_${Date.now()}`;
  const outputDir = path.join(TEMP_DIR, baseName);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.high;
    
    // Вызываем через python3 -m spotdl для надежности
    const args = [
        '-m', 'spotdl',
        'download', // Возвращаем команду download
        url,
        '--format', 'mp3',
        '--bitrate', preset.bitrate.toLowerCase(),
        '--output', '{title} - {artist}.{output-ext}',
        '--threads', '1',
        '--no-cache'
    ];

    if (SPOTIPY_CLIENT_ID && SPOTIPY_CLIENT_SECRET) {
        args.push('--client-id', SPOTIPY_CLIENT_ID, '--client-secret', SPOTIPY_CLIENT_SECRET);
    }

    // Прокси удаляем полностью, так как он вызывает Tunnel connection failed
    /*
    if (PROXY_URL) {
        args.push('--proxy', PROXY_URL);
    }
    */

    // spotdl v4.x плохо работает с куками YouTube, поэтому убираем их здесь
    // if (fs.existsSync(COOKIES_PATH)) {
    //     args.push('--cookie-file', COOKIES_PATH);
    //     console.log('[spotdl] Использую куки для авторизации');
    // }

    console.log(`[spotdl] Запуск: python3 ${args.join(' ')}`);
    
    const proc = spawn('python3', args, { cwd: outputDir });

    let stderrOutput = '';
    proc.stderr.on('data', (data) => {
      stderrOutput += data.toString();
      const msg = data.toString();
      if (msg.includes('ERROR') || msg.includes('Exception')) {
          console.error(`[spotdl] stderr: ${msg.trim()}`);
      }
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`[spotdl] Процесс завершился с кодом ${code}. Stderr: ${stderrOutput}`);
        return reject(new Error(`spotdl exited with code ${code}`));
      }
      
      const allFiles = fs.readdirSync(outputDir);
      console.log(`[spotdl] Содержимое папки после работы: ${allFiles.join(', ') || 'пусто'}`);

      const mp3Files = allFiles.filter(f => f.endsWith('.mp3'));
      if (mp3Files.length === 0) {
        if (allFiles.length > 0) {
            console.error(`[spotdl] Скачаны файлы, но нет .mp3: ${allFiles.join(', ')}. Проверьте работу ffmpeg.`);
        } else {
            console.error(`[spotdl] Папка пуста, файл не скачан. Stderr: ${stderrOutput}`);
        }
        return reject(new Error('spotdl не создал mp3 файл'));
      }
      
      const filePath = path.join(outputDir, mp3Files[0]);
      console.log(`[spotdl] Скачан: ${filePath}`);
      resolve(filePath);
    });

    proc.on('error', (err) => {
      reject(new Error(`spotdl spawn error: ${err.message}`));
    });
  });
}

/**
 * Скачивает трек через yt-dlp + ffmpeg и возвращает путь к mp3 файлу
 */
async function downloadWithYtdlpStream(url, quality = 'high') {
  const { spawn } = await import('child_process');
  
  return new Promise((resolve, reject) => {
    const searchUrl = url.includes('youtube.com') || url.includes('youtu.be') || url.startsWith('http') 
      ? url 
      : `ytsearch1:${url.replace(/^(ytsearch1:|ytmsearch1:)/, '')}`;

    const baseName = `stream_${Date.now()}`;
    const outputTemplate = path.join(TEMP_DIR, `${baseName}.%(ext)s`);

    // Определяем битрейт
    const bitrate = quality === 'high' ? '320K' : quality === 'medium' ? '192K' : '128K';

    const args = [
      '-m', 'yt_dlp',
      searchUrl,
      // ✅ ИСПРАВЛЕНО: Приоритет HTTP > HLS для быстрой загрузки
      '-f', 'http_mp3/bestaudio[protocol^=http]/bestaudio[protocol^=https]/bestaudio',
      '-x',                              // Extract audio
      '--audio-format', 'mp3',           // Конвертируем в mp3
      '--audio-quality', '0',            // Лучшее качество конвертации
      '--postprocessor-args', `ffmpeg:-b:a ${bitrate}`,  // Битрейт через ffmpeg
      '-o', outputTemplate,
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--geo-bypass',
      '--ffmpeg-location', ffmpegPath,
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      '--retries', '5',
      '--fragment-retries', '10',
      '--extractor-retries', '3',
      // ✅ Для HLS (если HTTP недоступен) - многопоточность
      '--concurrent-fragments', '8', // 8 параллельных соединений для HLS
      '--buffer-size', '64K', // Увеличить буфер
      '--http-chunk-size', '10M', // Размер чанков
    ];
    
    if (WRITABLE_COOKIES_PATH && fs.existsSync(WRITABLE_COOKIES_PATH)) {
      args.push('--cookies', WRITABLE_COOKIES_PATH);
      console.log(`[yt-dlp/file] Использую куки из: ${WRITABLE_COOKIES_PATH}`);
    } else {
      console.warn('[yt-dlp/file] Куки не найдены, пробую без них (возможна блокировка)');
    }
    
    console.log(`[yt-dlp/file] Скачиваю: ${searchUrl.slice(0, 60)}...`);
    console.log(`[yt-dlp/file] Качество: ${bitrate}`);
    
    const proc = spawn('python3', args);
    
    let stderrOutput = '';
    
    proc.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.log(`[yt-dlp] ${msg.slice(0, 150)}`);
    });
    
    proc.stderr.on('data', (data) => {
      const msg = data.toString();
      stderrOutput += msg;
      // Показываем прогресс
      if (msg.includes('%') || msg.includes('Downloading') || msg.includes('Extracting')) {
        console.log(`[yt-dlp] ${msg.trim().slice(0, 100)}`);
      }
    });
    
    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`[yt-dlp/file] Код выхода: ${code}`);
        console.error(`[yt-dlp/file] Stderr: ${stderrOutput.slice(-500)}`);
        return reject(new Error(`yt-dlp exited with code ${code}`));
      }
      
      // Ищем созданный файл
      const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(baseName));
      
      if (files.length === 0) {
        console.error('[yt-dlp/file] Файл не создан!');
        console.error(`[yt-dlp/file] Содержимое TEMP_DIR: ${fs.readdirSync(TEMP_DIR).join(', ')}`);
        return reject(new Error('yt-dlp не создал файл'));
      }
      
      const filePath = path.join(TEMP_DIR, files[0]);
      const stats = fs.statSync(filePath);
      
      console.log(`[yt-dlp/file] ✅ Скачан: ${filePath}`);
      console.log(`[yt-dlp/file] Размер: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
      
      // Возвращаем поток из файла
      const stream = fs.createReadStream(filePath);
      stream._filePath = filePath; // Сохраняем путь для очистки
      
      resolve(stream);
    });
    
    proc.on('error', (err) => {
      reject(new Error(`yt-dlp spawn error: ${err.message}`));
    });
  });
}

/**
 * Скачивает трек через yt-dlp в файл (надёжный fallback)
 */
async function downloadWithYtdlp(url, quality = 'high') {
  const { spawn } = await import('child_process');
  
  return new Promise((resolve, reject) => {
    const baseName = `dl_${Date.now()}`;
    const outputTemplate = path.join(TEMP_DIR, `${baseName}.%(ext)s`);
    
    const bitrate = quality === 'high' ? '320K' : quality === 'medium' ? '192K' : '128K';
    
    const args = [
      '-m', 'yt_dlp',
      url,
      // ✅ ИСПРАВЛЕНО: Приоритет HTTP > HLS для быстрой загрузки
      '-f', 'http_mp3/bestaudio[protocol^=http]/bestaudio[protocol^=https]/bestaudio',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--postprocessor-args', `ffmpeg:-b:a ${bitrate}`,
      '-o', outputTemplate,
      '--no-playlist',
      '--no-warnings',
      '--ffmpeg-location', ffmpegPath,
      '--retries', '5',
      '--geo-bypass',
      '--no-check-certificates',
      // ✅ Для HLS (если HTTP недоступен) - многопоточность
      '--concurrent-fragments', '8', // 8 параллельных соединений для HLS
      '--fragment-retries', '10',
      '--buffer-size', '64K', // Увеличить буфер
      '--http-chunk-size', '10M', // Размер чанков
    ];
    
    if (WRITABLE_COOKIES_PATH && fs.existsSync(WRITABLE_COOKIES_PATH)) {
      args.push('--cookies', WRITABLE_COOKIES_PATH);
      console.log(`[yt-dlp/fallback] Использую куки из: ${WRITABLE_COOKIES_PATH}`);
    } else {
      console.warn('[yt-dlp/fallback] Куки не найдены, пробую без них (возможна блокировка)');
    }
    
    console.log(`[yt-dlp/fallback] Скачиваю: ${url.slice(0, 60)}...`);
    
    const proc = spawn('python3', args);
    
    let stderrOutput = '';
    
    proc.stdout.on('data', (data) => {
      console.log(`[yt-dlp] ${data.toString().slice(0, 100)}`);
    });
    
    proc.stderr.on('data', (data) => {
      stderrOutput += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`[yt-dlp/fallback] Ошибка ${code}: ${stderrOutput.slice(-500)}`);
        return reject(new Error(`yt-dlp exited with code ${code}`));
      }
      
      // Ищем файл (может быть .mp3 или другое расширение до конвертации)
      const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(baseName));
      
      if (files.length === 0) {
        console.error(`[yt-dlp/fallback] Файлы не найдены.`);
        console.error(`[yt-dlp/fallback] Stderr: ${stderrOutput}`);
        console.error(`[yt-dlp/fallback] TEMP_DIR содержит: ${fs.readdirSync(TEMP_DIR).slice(0, 10).join(', ')}`);
        return reject(new Error('Файл не найден после скачивания'));
      }
      
      const filePath = path.join(TEMP_DIR, files[0]);
      const sizeMB = (fs.statSync(filePath).size / 1024 / 1024).toFixed(2);
      console.log(`[yt-dlp/fallback] ✅ Готово: ${filePath} (${sizeMB} MB)`);
      
      resolve(filePath);
    });
    
    proc.on('error', (err) => {
      reject(new Error(`spawn error: ${err.message}`));
    });
  });
}

// --- Вспомогательные функции ---

function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return 'track';
  return name.replace(/[<>:"/\\|?*]+/g, '').trim() || 'track';
}

function getCacheKey(meta, fallbackUrl) {
  if (meta?.id) return `sc:${meta.id}`;
  return fallbackUrl || 'unknown';
}

async function safeSendMessage(userId, text, extra = {}) {
  try {
    return await bot.telegram.sendMessage(userId, text, extra);
  } catch (e) {
    // Если юзер заблокировал бота (403)
    if (e.response?.error_code === 403) {
      await db.updateUserField(userId, 'active', false).catch(() => {});
    }
    return null;
  }
}

async function incrementDownload(userId, trackTitle, fileId, cacheKey, source = null) {
  const updatedUser = await db.incrementDownloadsAndSaveTrack(userId, trackTitle, fileId, cacheKey, source);
  if (updatedUser) {
    checkAndSendYandexPromo(userId, updatedUser);
  }
  return updatedUser;
}

const YANDEX_PROMO_TEXT =
  '🔥 Вижу, ты скачал уже 3 трека\\! Как тебе скорость?\n\n' +
  'Бот работает *абсолютно бесплатно*, без лимитов и подписок\\. ' +
  'Но ты можешь поддержать нас \\(и получить бонус себе\\) 👇\n\n' +
  '🎁 *Яндекс дарит 300₽ на баланс телефона*, если просто сделать его поиском по умолчанию в Safari или Chrome\\.\n\n' +
  'Занимает 1 минуту, деньги приходят сразу на счет\\.\n' +
  '_\\(Работает только с телефона, если Яндекс еще не стоял по умолчанию\\)_';

const YANDEX_PROMO_URL =
  'https://yandex.ru/portal/defsearchpromo/landing/ru_mobile300?partner=G8FvrGl1U5keQ46802&offer_type=DLbgMOQ1TioAY31862&utm_source=promocodes_ru&utm_medium=affiliate_default&utm_campaign=300&utm_content=90920252&clid=14695911';

function checkAndSendYandexPromo(userId, user) {
  if (!user || user.downloads_count !== 3 || user.yandex_promo_shown === true) return;

  (async () => {
    try {
      const wasSet = await db.markYandexPromoShown(userId);
      if (!wasSet) return;

      setTimeout(async () => {
        try {
          await bot.telegram.sendMessage(userId, YANDEX_PROMO_TEXT, {
            parse_mode: 'MarkdownV2',
            disable_web_page_preview: true,
            ...Markup.inlineKeyboard([
              [Markup.button.url('💰 Забрать 300₽ на телефон', YANDEX_PROMO_URL)]
            ])
          });
          console.log(`[YandexPromo] ✅ Промо отправлено пользователю ${userId}`);
        } catch (e) {
          console.error(`[YandexPromo] Ошибка отправки для ${userId}:`, e.message);
        }
      }, 2500);
    } catch (e) {
      console.error(`[YandexPromo] Ошибка проверки для ${userId}:`, e.message);
    }
  })();
}

async function getUserUsage(userId) {
  return await db.getUser(userId);
}

// Преобразует данные от ytdl/scdl в наш формат
function extractMetadataFromInfo(info) {
  const e = Array.isArray(info?.entries) ? info.entries[0] : info;
  if (!e) return null;
  return {
    id: e.id,
    webpage_url: e.webpage_url || e.url,
    title: sanitizeFilename(e.title || 'Unknown Title'),
    uploader: e.uploader || 'Unknown Artist',
    duration: e.duration,
    thumbnail: e.thumbnail,
  };
}

// Гарантирует наличие метаданных (если их нет, качает через ytdl)
async function ensureTaskMetadata(task) {
  let { metadata, cacheKey } = task;
  const url = task.url || task.originalUrl;
  
  if (!metadata) {
    if (!url) throw new Error('TASK_MISSING_URL');
    
    // Если это не ссылка на SoundCloud, не мучаем их API
    if (!url.includes('soundcloud.com')) {
        console.warn('[Worker] Не SoundCloud URL, используем ytdl для метаданных:', url);
        const info = await ytdl(url, { 'dump-single-json': true, 'no-playlist': true, 'ignore-errors': true, ...YTDL_COMMON });
        metadata = extractMetadataFromInfo(info);
    } else {
        console.warn('[Worker] Metadata отсутствует, получаем через ytdl для SoundCloud:', url);
        const info = await ytdl(url, { 'dump-single-json': true, 'no-playlist': true, 'ignore-errors': true, ...YTDL_COMMON });
        metadata = extractMetadataFromInfo(info);
    }
    
    if (!metadata) throw new Error('META_MISSING');
  }
  
  if (!cacheKey) {
    cacheKey = getCacheKey(metadata, task.originalUrl || url);
  }
  return { metadata, cacheKey, url };
}
/**
 * Скачивает трек и возвращает file_id из Telegram
 * Используется для "Исправить и отправить"
 */
export async function downloadTrackForUser(url, userId, metadata = null) {
  let tempFilePath = null;
  
  try {
    // Получаем метаданные если нет
    if (!metadata) {
      const info = await ytdl(url, { 
        'dump-single-json': true, 
        'skip-download': true,
        ...YTDL_OPTIONS 
      });
      metadata = extractMetadataFromInfo(info);
    }
    
    if (!metadata) throw new Error('META_MISSING');
    
    const { title, uploader, duration, webpage_url: fullUrl } = metadata;
    const roundedDuration = duration ? Math.round(duration) : null;
    
    console.log(`[DownloadForUser] Скачиваю: "${title}" для User ${userId}`);
    
    let audioSource;
    let method = 'unknown';
    
    // ✅ Используем только yt-dlp для всех источников (scdl отключен)
    console.log(`[DownloadForUser] Использую YT-DLP для: ${url}`);
    tempFilePath = await downloadWithYtdlp(fullUrl || url, 'high');
    
    // 🔥 Проверка размера файла перед отправкой
    const fileSize = fs.statSync(tempFilePath).size;
    const fileSizeMB = fileSize / 1024 / 1024;
    
    if (fileSizeMB < 0.1) {
      console.warn(`[DownloadForUser] ⚠️ Файл слишком маленький (${fileSizeMB.toFixed(3)} MB). Вероятно, ошибка скачивания.`);
      throw new Error('FILE_TOO_SMALL');
    }
    
    audioSource = { source: fs.createReadStream(tempFilePath), filename: `${sanitizeFilename(title)}.mp3` };
    method = 'YT-DLP';
    
    // Отправляем в хранилище
    if (STORAGE_CHANNEL_ID) {
      const sentMsg = await bot.telegram.sendAudio(
        STORAGE_CHANNEL_ID,
        audioSource,
        { title, performer: uploader }
      );
      
      const realDuration = sentMsg.audio?.duration || 0;
      const fileId = sentMsg.audio?.file_id;
      
      // Проверка на превью (слишком короткий файл - вероятно, превью)
      if (roundedDuration && roundedDuration > 60 && realDuration < 35) {
        await bot.telegram.deleteMessage(STORAGE_CHANNEL_ID, sentMsg.message_id).catch(() => {});
        throw new Error('PREVIEW_ONLY');
      }
      
      // Дополнительная проверка: если файл меньше 0.1 MB, это явно ошибка
      if (fileSizeMB < 0.1) {
        await bot.telegram.deleteMessage(STORAGE_CHANNEL_ID, sentMsg.message_id).catch(() => {});
        throw new Error('FILE_TOO_SMALL');
      }
      
      // Кэшируем
      await db.cacheTrack({
        url: fullUrl || url,
        fileId,
        title,
        artist: uploader,
        duration: realDuration,
        thumbnail: metadata.thumbnail,
        source: 'soundcloud',
        quality: 'high'
      });
      
      // Отправляем пользователю
      await bot.telegram.sendAudio(userId, fileId, {
        title,
        performer: uploader,
        duration: realDuration
      });
      
      console.log(`[DownloadForUser] ✅ Успешно (${method}): "${title}" → User ${userId}`);
      
      return { success: true, fileId, title, method };
    } else {
      throw new Error('STORAGE_NOT_CONFIGURED');
    }
    
  } catch (err) {
    console.error(`[DownloadForUser] ❌ Ошибка:`, err.message);
    throw err;
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch (e) {}
    }
  }
}

// =====================================================================================
//                             ГЛАВНЫЙ ПРОЦЕССОР ЗАГРУЗКИ (ИСПРАВЛЕННЫЙ)
// =====================================================================================

export async function trackDownloadProcessor(task) {
  const userId = parseInt(task.userId, 10);
  const source = task.source || 'soundcloud';
  const quality = task.quality || 'high';

  // ⚠️ ГИБРИДНАЯ АРХИТЕКТУРА — управляется из админки
  // Читаем настройку из БД (можно переключать без перезапуска)
  const USE_HYBRID_WORKER = getSetting('use_hybrid_worker') === 'true';
  
  // ============ ГИБРИДНАЯ АРХИТЕКТУРА ============
  // Spotify/YouTube → делегируем внешнему воркеру (HuggingFace)
  // Пропускаем делегирование, если это fallback после ошибки воркера
  if (USE_HYBRID_WORKER && (source === 'spotify' || source === 'youtube') && !task.skipWorker) {
    const hasWorker = await taskBroker.hasActiveWorker();
    
    if (hasWorker) {
      const title = task.metadata?.title || 'Unknown';
      const artist = task.metadata?.uploader || 'Unknown';
      
      // Формируем cacheKey с качеством
      const cacheKey = `${source}:${title}:${artist}:${quality}`
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^\w:_-]/g, '');
      
      console.log(`[Master] 📤 Делегирую воркеру: "${title}" (${quality})`);
      
      try {
        const taskId = await taskBroker.addTask({
          ...task,
          cacheKey
        });
        
        if (taskId) {
          // ✅ УБРАЛИ отправку сообщения здесь!
          // Сообщение уже отправлено в spotifyManager.js при добавлении в очередь
          return; // Воркер обработает и вернёт результат через Redis
        }
      } catch (e) {
        console.warn(`[Master] ⚠️ Делегирование не удалось: ${e.message}`);
        // Продолжаем обработку локально
      }
    } else {
      console.log(`[Master] ⚠️ Воркер неактивен, обрабатываю локально`);
    }
  }
  
  // ============ ЛОКАЛЬНАЯ ОБРАБОТКА ============
  let statusMessage = null;
  let tempFilePath = null;
  let thumbPath = null;
  let progressInterval = null; // Для индикатора прогресса
  
  try {
    // 1. Проверка лимитов
    const usage = await getUserUsage(userId);
    if (!usage || usage.downloads_today >= usage.premium_limit) {
      await safeSendMessage(userId, T('limitReached'));
      return;
    }

    // 2. Получение метаданных
    let metadata, cacheKey, fullUrl, title, uploader, roundedDuration;
    
    if (source === 'spotify' || source === 'youtube') {
      // Spotify/YouTube - метаданные уже есть в task
      metadata = task.metadata || {};
      title = metadata.title || 'Unknown';
      uploader = metadata.uploader || 'Unknown';
      roundedDuration = metadata.duration ? Math.round(metadata.duration) : undefined;
      fullUrl = task.url; // поисковый запрос или youtube url
      
      // ✅ Кэш с учётом качества
      const qualitySuffix = quality || 'medium';
      cacheKey = `${source}:${title}:${uploader}:${qualitySuffix}`
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^\w:_-]/g, '');
    } else {
      // SoundCloud - старая логика
      const ensured = await ensureTaskMetadata(task);
      metadata = ensured.metadata;
      cacheKey = ensured.cacheKey;
      title = metadata.title;
      uploader = metadata.uploader;
      roundedDuration = metadata.duration ? Math.round(metadata.duration) : undefined;
      fullUrl = metadata.webpage_url || task.url;
    }
    
    if (!fullUrl) throw new Error(`Нет ссылки на трек: ${title}`);

    console.log(`[Worker] CacheKey: ${cacheKey}`);

    // 3. Проверка КЭША
    let cached = await db.findCachedTrack(cacheKey, { source, quality });
    if (!cached && task.originalUrl) {
      cached = await db.findCachedTrack(task.originalUrl, { source, quality });
    }
    
    if (cached?.fileId) {
      console.log(`[Worker/Cache] ХИТ! Отправляю "${cached.title}" из кэша.`);
      await bot.telegram.sendAudio(userId, cached.fileId, { 
        title: cached.title, 
        performer: cached.artist || uploader, 
        duration: roundedDuration 
      });
      await incrementDownload(userId, cached.title, cached.fileId, cacheKey, source);
      return;
    }

    const qualityLabel = QUALITY_PRESETS[quality]?.label || quality;
    statusMessage = await safeSendMessage(userId, `⏳ Скачиваю: "${title}" (${qualityLabel})`);
    
    // Индикатор прогресса для пользователя
    let dots = 1;
    progressInterval = setInterval(async () => {
      if (statusMessage) {
        const dotString = '.'.repeat(dots);
        dots = (dots % 3) + 1;
        
        try {
          await bot.telegram.editMessageText(
            userId,
            statusMessage.message_id,
            null,
            `⏳ Скачиваю: "${title}" (${qualityLabel})${dotString}`
          );
        } catch (e) {
          // Игнорируем ошибки (сообщение может быть удалено)
        }
      }
    }, 5000); // Обновляем каждые 5 секунд
    
    let stream;
    let usedFallback = false;
    let spotifyBuffer = null; // Для хранения buffer'а из pipe-стриминга
    let finalFileId = null; // Может быть установлен для SoundCloud (быстрый путь)

    // Скачиваем обложку заранее (нужна для отправки в хранилище)
    if (metadata.thumbnail) {
      thumbPath = await downloadThumbnail(metadata.thumbnail);
    }

    // 4. СКАЧИВАНИЕ - РАЗНАЯ ЛОГИКА ДЛЯ РАЗНЫХ ИСТОЧНИКОВ
    
    if (source === 'soundcloud' && fullUrl.includes('soundcloud.com')) {
      // ===== SOUNDCLOUD: БЫСТРЫЙ ПУТЬ (scdl + FFmpeg) =====
      
      let sentToStorage = null;
      let usedSlowMethod = false;
      let scdlSucceeded = false;
      
      // Внешний try-catch для предотвращения uncaughtException
      try {
        console.log(`[Worker/SoundCloud] 🚀 Быстрый метод (scdl + ffmpeg): ${fullUrl}`);
        
        // Скачиваем через scdl, но сохраняем во временный файл с конвертацией
        const { spawn } = await import('child_process');
        const rawStream = await scdl.default.download(fullUrl);
        
        // Генерируем имя временного файла
        const outputPath = path.join(TEMP_DIR, `scdl_${Date.now()}.mp3`);
        
        // Конвертируем через FFmpeg (AAC/HLS → MP3)
        const FFMPEG_TIMEOUT = 30000; // 30 секунд
        await new Promise((resolve, reject) => {
          const ffmpeg = spawn(ffmpegPath, [
            '-i', 'pipe:0',           // Вход из stdin
            '-acodec', 'libmp3lame',  // Кодек MP3
            '-ab', '320k',            // Битрейт 320 kbps
            '-ar', '44100',           // Sample rate
            '-y',                     // Перезаписать если есть
            outputPath
          ]);
          
          let hasError = false;
          let stderrData = '';
          
          // Timeout для предотвращения зависания FFmpeg
          const timeoutId = setTimeout(() => {
            if (!hasError) {
              hasError = true;
              console.warn('[Worker/SoundCloud] FFmpeg timeout, killing process');
              ffmpeg.kill('SIGKILL');
              reject(new Error('FFmpeg timeout'));
            }
          }, FFMPEG_TIMEOUT);
          
          // Обработка ошибок stream'а от scdl
          rawStream.on('error', (err) => {
            if (!hasError) {
              hasError = true;
              clearTimeout(timeoutId);
              console.error(`[Worker/SoundCloud] SCDL Stream error: ${err.message}`);
              try {
                ffmpeg.stdin.end(); // Корректно закрываем stdin
              } catch (e) {
                // Игнорируем ошибки при закрытии
              }
              reject(err);
            }
          });
          
          // Обработка завершения потока от scdl
          rawStream.on('end', () => {
            console.log('[Worker/SoundCloud] SCDL Stream ended');
            try {
              ffmpeg.stdin.end(); // Закрываем stdin после завершения потока
            } catch (e) {
              // Игнорируем ошибки при закрытии
            }
          });
          
          // Подаём поток от scdl на вход ffmpeg с обработкой ошибок
          const pipedStream = rawStream.pipe(ffmpeg.stdin);
          
          // Обработка EPIPE ошибки на pipe (процесс закрылся, но мы пытаемся писать)
          pipedStream.on('error', (err) => {
            if (err.code === 'EPIPE') {
              // Игнорируем EPIPE, так как процесс уже мертв, и мы обработаем это в событии close
              return;
            }
            if (!hasError) {
              hasError = true;
              clearTimeout(timeoutId);
              console.error(`[Worker/SoundCloud] Pipe error: ${err.message}`);
              reject(err);
            }
          });
          
          // Также обрабатываем ошибки на stdin процесса ffmpeg
          ffmpeg.stdin.on('error', (err) => {
            if (err.code === 'EPIPE') {
              // Игнорируем EPIPE, процесс уже закрыт
              return;
            }
            if (!hasError) {
              hasError = true;
              clearTimeout(timeoutId);
              console.error(`[Worker/SoundCloud] FFmpeg stdin error: ${err.message}`);
              reject(err);
            }
          });
          
          ffmpeg.stderr.on('data', (data) => {
            stderrData += data.toString();
          });
          
          ffmpeg.on('close', (code) => {
            clearTimeout(timeoutId);
            if (hasError) return; // Уже обработана ошибка
            
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`FFmpeg exited with code ${code}: ${stderrData.slice(-200)}`));
            }
          });
          
          ffmpeg.on('error', (err) => {
            if (!hasError) {
              hasError = true;
              clearTimeout(timeoutId);
              reject(err);
            }
          });
        });
        
        // Проверяем размер файла
        const fileStats = fs.statSync(outputPath);
        const fileSizeMB = fileStats.size / 1024 / 1024;
        
        console.log(`[Worker/SoundCloud] 📁 Файл конвертирован: ${fileSizeMB.toFixed(2)} MB`);
        
        if (fileSizeMB < 0.1) {
          throw new Error('CONVERTED_FILE_TOO_SMALL');
        }
        
        tempFilePath = outputPath;
        stream = fs.createReadStream(outputPath);
        
        // Отправляем в хранилище
        if (STORAGE_CHANNEL_ID) {
          let retryCount = 0;
          const maxRetries = 3;
          
          while (retryCount < maxRetries) {
            try {
              if (retryCount > 0) {
                stream = fs.createReadStream(tempFilePath);
              }
              
              sentToStorage = await bot.telegram.sendAudio(
                STORAGE_CHANNEL_ID,
                { source: stream, filename: `${sanitizeFilename(title)}.mp3` },
                {
                  title,
                  performer: uploader,
                  duration: roundedDuration,
                  thumb: thumbPath ? { source: fs.createReadStream(thumbPath) } : undefined,
                  disable_notification: true
                }
              );
              break;
              
            } catch (sendErr) {
              if (sendErr.message?.includes('429')) {
                const retryMatch = sendErr.message.match(/retry after (\d+)/);
                const waitTime = retryMatch ? parseInt(retryMatch[1], 10) : 5;
                
                retryCount++;
                if (retryCount >= maxRetries) throw sendErr;
                
                console.log(`[Worker/SoundCloud] ⏳ Rate limit, жду ${waitTime + 1} сек...`);
                await new Promise(r => setTimeout(r, (waitTime + 1) * 1000));
                continue;
              }
              throw sendErr;
            }
          }
          
          const realDuration = sentToStorage?.audio?.duration || 0;
          const expectedDuration = roundedDuration || 0;
          
          console.log(`[Worker/SoundCloud] 📊 Ожидаемая: ${expectedDuration}с, Реальная: ${realDuration}с`);
          
          // Проверка на превью
          if (expectedDuration > 60 && realDuration < 35) {
            console.warn(`[Worker/SoundCloud] ⚠️ Обнаружено превью! Удаляю и пробую yt-dlp...`);
            await bot.telegram.deleteMessage(STORAGE_CHANNEL_ID, sentToStorage.message_id).catch(() => {});
            throw new Error('PREVIEW_DETECTED');
          }
          
          finalFileId = sentToStorage.audio?.file_id;
          scdlSucceeded = true;
          console.log(`[Worker/SoundCloud] ✅ Быстрый метод успешен!`);
        }
        
      } catch (scdlError) {
        // МЕДЛЕННЫЙ ПУТЬ: yt-dlp
        console.warn(`[Worker/SoundCloud] ⚠️ Быстрый метод не сработал: ${scdlError.message}`);
        console.log(`[Worker/SoundCloud] 🐢 Пробую yt-dlp...`);
        
        usedSlowMethod = true;
        
        // Удаляем битый временный файл если есть
        if (tempFilePath && fs.existsSync(tempFilePath)) {
          try { fs.unlinkSync(tempFilePath); } catch (e) {}
          tempFilePath = null;
        }
        
        try {
          tempFilePath = await downloadWithYtdlp(fullUrl, quality);
          
          const fileStats = fs.statSync(tempFilePath);
          const fileSizeMB = fileStats.size / 1024 / 1024;
          
          if (fileSizeMB < 0.3) {
            throw new Error('DOWNLOAD_FAILED_EMPTY');
          }
          
          // Проверяем длительность через ffprobe
          if (roundedDuration && roundedDuration > 60) {
            try {
              const { execSync } = await import('child_process');
              const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');              const probeCmd = `"${ffprobePath}" -v error -show_entries format=duration -of csv=p=0 "${tempFilePath}"`;
              const realDur = parseFloat(execSync(probeCmd, { encoding: 'utf8', timeout: 10000 }).trim()) || 0;
              
              console.log(`[Worker/SoundCloud] 📊 yt-dlp: Ожидаемая ${roundedDuration}с, Реальная ${realDur.toFixed(1)}с`);
              
              if (realDur < 35 && roundedDuration > 60) {
                throw new Error('PREVIEW_ONLY');
              }
            } catch (probeErr) {
              if (probeErr.message === 'PREVIEW_ONLY') throw probeErr;
            }
          }
          
          console.log(`[Worker/SoundCloud] ✅ yt-dlp успешен: ${fileSizeMB.toFixed(2)} MB`);
          
          // Отправляем в хранилище
          if (STORAGE_CHANNEL_ID) {
            stream = fs.createReadStream(tempFilePath);
            
            sentToStorage = await bot.telegram.sendAudio(
              STORAGE_CHANNEL_ID,
              { source: stream, filename: `${sanitizeFilename(title)}.mp3` },
              {
                title,
                performer: uploader,
                duration: roundedDuration,
                thumb: thumbPath ? { source: fs.createReadStream(thumbPath) } : undefined,
                disable_notification: true
              }
            );
            
            finalFileId = sentToStorage.audio?.file_id;
          }
          
        } catch (ytdlpError) {
          console.error(`[Worker/SoundCloud] ❌ Все методы провалились: ${ytdlpError.message}`);
          const reason = ytdlpError.message === 'PREVIEW_ONLY' ? 'PREVIEW_ONLY' : 'DOWNLOAD_FAILED';
          await db.logBrokenTrack(fullUrl, title, userId, reason).catch(() => {});
          throw ytdlpError;
        }
      }
      
      usedFallback = usedSlowMethod;
      
      // Для медленного пути (yt-dlp) нужно установить stream из tempFilePath
      // для случая, если хранилище не настроено (прямая отправка пользователю)
      if (usedSlowMethod && tempFilePath && !stream) {
        stream = fs.createReadStream(tempFilePath);
      }
      
    } else if (source === 'spotify') {
      // ===== SPOTIFY - ОПТИМИЗИРОВАННЫЙ МЕТОД С PIPE-СТРИМИНГОМ =====
      console.log(`[Worker/Spotify] Обработка: "${title}" by ${uploader}`);
      
      // Импортируем загрузчик
      const { downloadSpotifyStream, downloadSpotifyTrack } = await import('./spotifyDownloader.js');
      
      const searchQuery = `${uploader} ${title}`;
      
      try {
        // Пробуем быстрый стриминг (без записи на диск)
        const result = await downloadSpotifyStream(searchQuery, { quality });
        
        // Проверяем размер перед созданием стрима
        const fileSizeMB = result.size / 1024 / 1024;
        console.log(`[Worker/Spotify] ✅ Stream готов: ${fileSizeMB.toFixed(2)} MB`);
        
        if (fileSizeMB > 48) {
          console.warn(`[Worker/Spotify] ⚠️ Buffer слишком большой (${fileSizeMB.toFixed(1)} MB), используем fallback`);
          throw new Error('BUFFER_TOO_LARGE');
        }
        
        // Сохраняем buffer для повторного использования
        spotifyBuffer = result.buffer;
        
        // Отправляем buffer напрямую в Telegram
        stream = Readable.from(spotifyBuffer);
        stream._size = result.size; // Сохраняем размер для проверки
        usedFallback = false;
        
      } catch (streamErr) {
        console.warn(`[Worker/Spotify] Stream не сработал: ${streamErr.message}`);
        
        // Fallback на файловый метод
        const trackInfo = {
          title,
          artist: uploader,
          duration: roundedDuration
        };
        
        const result = await downloadSpotifyTrack(trackInfo, { quality });
        tempFilePath = result.filePath;
        stream = fs.createReadStream(tempFilePath);
        usedFallback = true;
        
        console.log(`[Worker/Spotify] ✅ Файл готов (fallback): ${(result.size / 1024 / 1024).toFixed(2)} MB`);
      }
      
    } else {
      // ===== YOUTUBE или другой источник =====
      let searchUrl = fullUrl;
      
      // Если это не URL, а поисковый запрос
      if (!fullUrl.startsWith('http')) {
        const cleanQuery = fullUrl.replace(/^(ytsearch1:|ytmsearch1:)/, '').trim();
        searchUrl = `ytmsearch1:${cleanQuery}`;
      }
      
      console.log(`[Worker/${source}] Потоковое скачивание: ${searchUrl}`);
      
      try {
        stream = await downloadWithYtdlpStream(searchUrl);
      } catch (streamErr) {
        console.warn(`[Worker] Stream ошибка (${streamErr.message}). Fallback на файл...`);
        tempFilePath = await downloadWithYtdlp(searchUrl, quality);
        stream = fs.createReadStream(tempFilePath);
        usedFallback = true;
      }
    }

    // Проверяем, что stream существует
    if (!stream) {
      throw new Error('Не удалось получить аудио поток');
    }

    // 5. ОТПРАВКА В TELEGRAM
    // finalFileId уже может быть установлен для SoundCloud (быстрый путь через scdl)
    // thumbPath уже скачан выше

    // Запоминаем путь к файлу из стрима (если есть)
    if (stream?._filePath && !tempFilePath) {
      tempFilePath = stream._filePath;
    }

    // А) В канал-хранилище (если настроен и еще не отправлено)
    // Для SoundCloud файл уже может быть отправлен через быстрый путь (scdl)
    if (STORAGE_CHANNEL_ID && !finalFileId) {
      try {
        // Проверяем размер файла или buffer
        let fileSizeMB = 0;
        
        if (tempFilePath && fs.existsSync(tempFilePath)) {
          const fileSize = fs.statSync(tempFilePath).size;
          fileSizeMB = fileSize / 1024 / 1024;
          
          console.log(`[Worker] Размер файла: ${fileSizeMB.toFixed(2)} MB`);
          
          if (fileSizeMB > 48) {
            console.warn(`[Worker] ⚠️ Файл слишком большой (${fileSizeMB.toFixed(1)} MB), пропускаем хранилище`);
            throw new Error('FILE_TOO_LARGE');
          }
          
          // 🔥 Проверка минимального размера (защита от битых файлов)
          if (fileSizeMB < 0.1) {
            console.warn(`[Worker] ⚠️ Файл слишком маленький (${fileSizeMB.toFixed(3)} MB). Вероятно, ошибка скачивания.`);
            throw new Error('FILE_TOO_SMALL');
          }
          
          // Пересоздаём стрим
          stream = fs.createReadStream(tempFilePath);
        } else if (stream?._size) {
          // Проверяем размер buffer-стрима
          fileSizeMB = stream._size / 1024 / 1024;
          console.log(`[Worker] Размер buffer: ${fileSizeMB.toFixed(2)} MB`);
          
          if (fileSizeMB > 48) {
            console.warn(`[Worker] ⚠️ Buffer слишком большой (${fileSizeMB.toFixed(1)} MB), пропускаем хранилище`);
            throw new Error('BUFFER_TOO_LARGE');
          }
          
          // 🔥 Проверка минимального размера для buffer (защита от битых файлов)
          if (fileSizeMB < 0.1) {
            console.warn(`[Worker] ⚠️ Buffer слишком маленький (${fileSizeMB.toFixed(3)} MB). Вероятно, ошибка скачивания.`);
            throw new Error('FILE_TOO_SMALL');
          }
        }

        console.log(`[Worker] Отправка в хранилище...`);
        
        const sourceName = source === 'soundcloud' ? 'SoundCloud' : 
                          (source === 'spotify' ? 'Spotify' : 'YouTube Music');
        const caption = `🎵 <b>${title}</b>\n` +
                       `👤 <b>Артист:</b> ${uploader}\n` +
                       `⏱ <b>Длительность:</b> ${formatDuration(roundedDuration)}\n` +
                       `🔗 <b>Источник:</b> ${sourceName}`;

        const sentToStorage = await bot.telegram.sendAudio(
          STORAGE_CHANNEL_ID,
          { source: stream, filename: `${sanitizeFilename(title)}.mp3` },
          {
            title,
            performer: uploader,
            duration: roundedDuration,
            thumb: thumbPath ? { source: fs.createReadStream(thumbPath) } : undefined,
            caption,
            parse_mode: 'HTML',
            disable_notification: true
          }
        );
        finalFileId = sentToStorage?.audio?.file_id;
        
        console.log(`[Worker] ✅ Загружено в хранилище, file_id: ${finalFileId?.slice(0, 20)}...`);
        
      } catch (e) {
        console.error(`❌ Ошибка отправки в хранилище:`, e.message);
        
        // Пересоздаём стрим для отправки юзеру
        if (tempFilePath && fs.existsSync(tempFilePath)) {
          stream = fs.createReadStream(tempFilePath);
        } else if (spotifyBuffer) {
          // Пересоздаём stream из buffer
          stream = Readable.from(spotifyBuffer);
        }
      }
    }

    // Б) Если получили file_id -> Сохраняем в БД и отправляем юзеру
    if (finalFileId) {
      const urlAliases = [];
      if (task.originalUrl && task.originalUrl !== cacheKey) urlAliases.push(task.originalUrl);
      if (fullUrl && fullUrl !== cacheKey && source !== 'spotify') urlAliases.push(fullUrl);
      
      // ✅ Для Spotify не добавляем алиасы без качества, чтобы не перезаписывать разные качества
      await db.cacheTrack({ 
        url: cacheKey,  // spotify:title:artist:quality
        fileId: finalFileId, 
        title, 
        artist: uploader, 
        duration: roundedDuration, 
        thumbnail: metadata.thumbnail,
        source,
        quality,
        spotifyId: source === 'spotify' && task.originalUrl?.match(/track\/([a-zA-Z0-9]+)/)?.[1] || null,
        aliases: source === 'spotify' 
          ? (task.originalUrl ? [`${task.originalUrl}:${quality}`] : [])
          : urlAliases
      });
      
      console.log(`✅ [Cache] Трек "${title}" (${quality}) сохранён (key: ${cacheKey}).`);
      
      await bot.telegram.sendAudio(userId, finalFileId, { 
        title, 
        performer: uploader, 
        duration: roundedDuration 
      });
      
      // Удаляем статусное сообщение (если есть)
      if (task.statusMessageId) {
        try {
          await bot.telegram.deleteMessage(userId, task.statusMessageId);
          console.log(`[Worker] 🗑️ Deleted status message: ${task.statusMessageId}`);
        } catch (e) {
          // Игнорируем ошибки удаления
        }
      }
      
      await incrementDownload(userId, title, finalFileId, task.originalUrl || cacheKey, source);

    } else {
      // В) Если хранилище недоступно -> Отправляем напрямую юзеру
      console.warn('[Worker] Отправляю напрямую пользователю (без кэша)...');
      
      // Пересоздаём стрим если нужно
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        // 🔥 Проверка размера файла перед отправкой
        const fileSize = fs.statSync(tempFilePath).size;
        const fileSizeMB = fileSize / 1024 / 1024;
        
        if (fileSizeMB < 0.1) {
          console.warn(`[Worker] ⚠️ Файл слишком маленький (${fileSizeMB.toFixed(3)} MB). Вероятно, ошибка скачивания.`);
          throw new Error('FILE_TOO_SMALL');
        }
        
        stream = fs.createReadStream(tempFilePath);
      } else if (spotifyBuffer) {
        // 🔥 Проверка размера buffer перед отправкой
        const bufferSizeMB = spotifyBuffer.length / 1024 / 1024;
        
        if (bufferSizeMB < 0.1) {
          console.warn(`[Worker] ⚠️ Buffer слишком маленький (${bufferSizeMB.toFixed(3)} MB). Вероятно, ошибка скачивания.`);
          throw new Error('FILE_TOO_SMALL');
        }
        
        // Пересоздаём stream из buffer
        stream = Readable.from(spotifyBuffer);
      } else if (!stream || stream.destroyed || stream.readableEnded) {
        // ✅ Используем только yt-dlp для всех источников (scdl отключен)
        const searchQuery = source === 'spotify' 
          ? `ytmsearch1:${uploader} - ${title}`
          : fullUrl;
        
        console.log(`[Worker] Повторное скачивание через yt-dlp: ${searchQuery}`);
        tempFilePath = await downloadWithYtdlp(searchQuery, quality);
        
        // 🔥 Проверка размера после скачивания
        const fileSize = fs.statSync(tempFilePath).size;
        const fileSizeMB = fileSize / 1024 / 1024;
        
        if (fileSizeMB < 0.1) {
          console.warn(`[Worker] ⚠️ Файл слишком маленький после повторного скачивания (${fileSizeMB.toFixed(3)} MB).`);
          throw new Error('FILE_TOO_SMALL');
        }
        
        stream = fs.createReadStream(tempFilePath);
      }

      await bot.telegram.sendAudio(
        userId, 
        { source: stream, filename: `${sanitizeFilename(title)}.mp3` },
        { title, performer: uploader, duration: roundedDuration }
      );
      
      // Удаляем статусное сообщение (если есть)
      if (task.statusMessageId) {
        try {
          await bot.telegram.deleteMessage(userId, task.statusMessageId);
          console.log(`[Worker] 🗑️ Deleted status message: ${task.statusMessageId}`);
        } catch (e) {
          // Игнорируем ошибки удаления
        }
      }
      
      console.log(`✅ [Direct] Отправлено пользователю (без кэша)`);
    }

  } catch (err) {
    const errorDetails = err?.stderr || err?.message || 'Unknown error';
    console.error(`❌ Ошибка воркера (User ${userId}):`, errorDetails);
    
    let userMsg = `❌ Не удалось скачать трек`;
    const trackTitle = task.metadata?.title || 'Unknown';
    const trackUrl = task.originalUrl || task.url || '';
    
    if (trackTitle !== 'Unknown') userMsg += `: "${trackTitle}"`;
    
    // Определяем причину ошибки
    let reason = 'UNKNOWN_ERROR';
    
    // 🔥 ДОБАВЛЕНА ОБРАБОТКА PREVIEW_ONLY И DOWNLOAD_FAILED_EMPTY 🔥
    if (err.message === 'PREVIEW_ONLY') {
      userMsg = `❌ К сожалению, "${trackTitle}" защищён от скачивания.\n\n💡 SoundCloud отдаёт только превью (30 сек). Попробуйте найти этот трек на Spotify.`;
      reason = 'PREVIEW_ONLY';
    } else if (err.message === 'DOWNLOAD_FAILED_EMPTY') {
      userMsg = `❌ Не удалось скачать "${trackTitle}".\n\n💡 Возможно, трек удалён или защищён. Попробуйте другую ссылку.`;
      reason = 'DOWNLOAD_FAILED_EMPTY';
    } else if (errorDetails.includes('404') || errorDetails.includes('Video unavailable')) {
      userMsg += "\n\n💡 Трек не найден на YouTube Music. Попробуйте отправить название трека текстом.";
      reason = '404_NOT_FOUND';
    } else if (errorDetails.includes('403')) {
      reason = '403_FORBIDDEN';
    } else if (errorDetails.includes('Sign in') || errorDetails.includes('bot')) {
      userMsg += "\n\n⚠️ YouTube требует авторизацию. Попробуйте позже.";
      reason = 'AUTH_REQUIRED';
    }
    
    // Логируем битый трек
    await db.logBrokenTrack(trackUrl, trackTitle, userId, reason).catch(() => {});

    await safeSendMessage(userId, userMsg);

  } finally {
    // 6. ОЧИСТКА
    if (progressInterval) {
      clearInterval(progressInterval);
    }
    
    if (statusMessage) {
      try { await bot.telegram.deleteMessage(userId, statusMessage.message_id); } catch (e) {}
    }

    // Закрываем незавершённый стрим, если он ещё жив
    if (stream && !stream.destroyed) {
      try { stream.destroy(); } catch (e) {}
    }
    
    // Удаляем временные файлы
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
        
        const parentDir = path.dirname(tempFilePath);
        if (path.basename(parentDir).startsWith('spot_')) {
          fs.rmSync(parentDir, { recursive: true, force: true });
        }
      } catch (e) {}
    }
    
    if (thumbPath && fs.existsSync(thumbPath)) {
      try { fs.unlinkSync(thumbPath); } catch (e) {}
    }
  }
}

// =====================================================================================
//                                 ОЧЕРЕДЬ ЗАГРУЗОК
// =====================================================================================

export const downloadQueue = new TaskQueue({
  maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
  taskProcessor: trackDownloadProcessor
});

console.log(`[DownloadManager] Очередь (threads=${MAX_CONCURRENT_DOWNLOADS})`);

// =====================================================================================
//                                 ФУНКЦИЯ ENQUEUE
// =====================================================================================

export function enqueue(ctx, userId, url, earlyData = {}) {
  (async () => {
    let statusMessage = null;
    console.log(`[Enqueue] User ${userId}, URL: ${url}`);
    
    try {
      // Проверка бонусов/лимитов
      const user = await db.getUser(userId);
      if ((user.downloads_today || 0) >= user.premium_limit) {
          const bonusAvailable = Boolean(CHANNEL_USERNAME && !user?.subscribed_bonus_used);
          const cleanUsername = CHANNEL_USERNAME?.replace('@', '');
          const bonusText = bonusAvailable ? `\n\n🎁 Доступен бонус! Подпишись на <a href="https://t.me/${cleanUsername}">@${cleanUsername}</a> и получи <b>7 дней тарифа Plus</b>.` : '';
          const text = `${T('limitReached')}${bonusText}`;
          const extra = { parse_mode: 'HTML', disable_web_page_preview: true };
          if (bonusAvailable) {
            extra.reply_markup = { inline_keyboard: [[Markup.button.callback('✅ Я подписался, забрать бонус', 'check_subscription')]] };
          }
          await safeSendMessage(userId, text, extra);
          return;
      }

      // 1. FAST PATH (если метаданные уже есть из поиска)
      if (earlyData.isSingleTrack && earlyData.metadata) {
        console.log('[Enqueue/Fast] Метаданные получены заранее.');
        const metadata = extractMetadataFromInfo(earlyData.metadata);
        const { webpage_url: fullUrl, id } = metadata;
        const cacheKey = id ? `sc:${id}` : null;

        // Проверка кэша
        const cached = await db.findCachedTrack(url, { source: 'soundcloud' }) 
          || await db.findCachedTrack(fullUrl, { source: 'soundcloud' }) 
          || (cacheKey && await db.findCachedTrack(cacheKey, { source: 'soundcloud' }));
        if (cached?.fileId) {
          console.log(`[Enqueue/Fast] ХИТ КЭША!`);
          await bot.telegram.sendAudio(userId, cached.fileId, { title: cached.title, performer: cached.artist });
          await incrementDownload(userId, cached.title, cached.fileId, url, 'soundcloud');
          return;
        }

        // Добавляем в очередь
        const task = { userId, url: fullUrl, originalUrl: url, source: 'soundcloud', cacheKey, metadata };
        downloadQueue.add({ ...task, priority: user.premium_limit || 5 }).catch(err => {
          if (err.message === 'TASK_TIMEOUT') {
            console.error(`[TaskQueue] Задача отменена по таймауту: ${metadata.title}`);
          } else {
            console.error('[TaskQueue] Ошибка выполнения задачи:', err.message);
          }
        });
        await safeSendMessage(userId, `✅ Трек "${metadata.title}" добавлен в очередь.`);
        return;
      }

      // 2. SLOW PATH (Если просто кинули ссылку)
      // Сначала проверим кэш по URL, чтобы не делать лишних запросов
      const quickCache = await db.findCachedTrack(url, { source: 'soundcloud' });
      if (quickCache?.fileId) {
          console.log(`[Enqueue/Slow] ХИТ КЭША по URL!`);
          await bot.telegram.sendAudio(userId, quickCache.fileId, { title: quickCache.title, performer: quickCache.artist });
          await incrementDownload(userId, quickCache.title, quickCache.fileId, url);
          return;
      }

      statusMessage = await safeSendMessage(userId, '🔍 Анализирую ссылку...');
      
      // Получаем инфо через yt-dlp
      const info = await ytdl(url, { 'dump-single-json': true, 'flat-playlist': true, ...YTDL_COMMON });
      
      // Удаляем сообщение "Анализирую..."
      if (statusMessage) {
        await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
      }

      // Это плейлист?
      if (info.entries && info.entries.length > 0) {
          await safeSendMessage(userId, `📂 Найден плейлист/альбом: "${info.title || 'Playlist'}".\nДобавляю ${info.entries.length} треков...`);
          
          let addedCount = 0;
          for (const entry of info.entries) {
              const meta = extractMetadataFromInfo(entry);
              if (meta) {
                  const task = { userId, url: meta.webpage_url, originalUrl: url, source: 'soundcloud', metadata: meta };
                  downloadQueue.add({ ...task, priority: user.premium_limit || 5 }).catch(err => {
                    if (err.message === 'TASK_TIMEOUT') {
                      console.error(`[TaskQueue] Задача отменена по таймауту: ${meta.title}`);
                    } else {
                      console.error('[TaskQueue] Ошибка выполнения задачи:', err.message);
                    }
                  });
                  addedCount++;
              }
          }
          await safeSendMessage(userId, `✅ Добавлено в очередь: ${addedCount} треков.`);
      } else {
          // Одиночный трек
          const meta = extractMetadataFromInfo(info);
          if (meta) {
              const task = { userId, url: meta.webpage_url, originalUrl: url, source: 'soundcloud', metadata: meta };
              downloadQueue.add({ ...task, priority: user.premium_limit || 5 }).catch(err => {
                if (err.message === 'TASK_TIMEOUT') {
                  console.error(`[TaskQueue] Задача отменена по таймауту: ${meta.title}`);
                } else {
                  console.error('[TaskQueue] Ошибка выполнения задачи:', err.message);
                }
              });
              await safeSendMessage(userId, `✅ Трек "${meta.title}" добавлен в очередь.`);
          } else {
              throw new Error('Не удалось извлечь данные о треке.');
          }
      }

    } catch (err) {
      console.error(`[Enqueue] Ошибка:`, err.message);
      if (statusMessage) {
        await bot.telegram.deleteMessage(userId, statusMessage.message_id).catch(() => {});
      }
      await safeSendMessage(userId, `❌ Ошибка при чтении ссылки. Возможно, она приватная или неверная.`);
    }
  })().catch(e => console.error('Async Enqueue Error:', e));
}

/**
 * Инициализирует Download Manager и подключается к Redis для гибридной архитектуры
 */
export async function initializeDownloadManager() {
  // Подключаемся к Upstash Redis для гибридной архитектуры
  const connected = await taskBroker.connect();
  
  if (connected) {
    console.log('[DownloadManager] ✅ TaskBroker подключён к Upstash');
    
    // Слушаем результаты от воркера
    taskBroker.on('result', async (result) => {
      console.log(`[Master] 📥 Получен результат: ${result.title}`);
      
      try {
        if (result.success && result.fileId) {
          // Сохраняем в кэш
          await db.cacheTrack({
            url: result.cacheKey,
            fileId: result.fileId,
            title: result.title,
            artist: result.artist,
            duration: result.duration,
            source: result.source || 'spotify',
            quality: result.quality || 'high',
            spotifyId: result.spotifyId || null
          });
          
          console.log(`[Master] ✅ Кэш сохранён: ${result.title}`);
          
          // Отправляем пользователю
          await bot.telegram.sendAudio(result.userId, result.fileId, {
            title: result.title,
            performer: result.artist,
            duration: result.duration
          });
          
          // Обновляем статистику
          const updatedUser = await db.incrementDownloadsAndSaveTrack(
            result.userId,
            result.title,
            result.fileId,
            result.cacheKey,
            result.source || 'spotify'
          );
          if (updatedUser) checkAndSendYandexPromo(result.userId, updatedUser);
          
          // Удаляем статусное сообщение (если есть и еще не удалено)
          if (result.statusMessageId) {
            try {
              await bot.telegram.deleteMessage(result.userId, result.statusMessageId);
              console.log(`[Master] 🗑️ Удалено статусное сообщение ${result.statusMessageId}`);
            } catch (e) {
              // Игнорируем ошибки удаления (сообщение уже удалено или не существует)
            }
          }
          
          console.log(`[Master] ✅ Отправлено пользователю ${result.userId}`);
          
        } else {
          // Ошибка воркера — пробуем обработать локально (fallback)
          const errorMsg = result.error || '';
          const isNetworkError = errorMsg.includes('No address associated with hostname') || 
                                 errorMsg.includes('network') || 
                                 errorMsg.includes('timeout');
          
          console.log(`[Master] ❌ Ошибка от воркера: ${errorMsg}`);
          
          // Удаляем статусное сообщение (если есть)
          if (result.statusMessageId) {
            try {
              await bot.telegram.deleteMessage(result.userId, result.statusMessageId);
              console.log(`[Master] 🗑️ Удалено статусное сообщение ${result.statusMessageId}`);
            } catch (e) {
              // Игнорируем ошибки удаления
            }
          }
          
          // Если это сетевая ошибка — пробуем обработать локально
          if (isNetworkError && result.task) {
            console.log(`[Master] 🔄 Fallback: обрабатываю локально из-за сетевой ошибки`);
            try {
              // Добавляем задачу обратно в очередь для локальной обработки
              // Флаг skipWorker предотвратит повторное делегирование воркеру
              const fallbackTask = {
                ...result.task,
                isPlaylistItem: result.task.isPlaylistItem || false,
                statusMessageId: undefined, // Не передаем, чтобы не удалять сообщение дважды
                skipWorker: true // Флаг для пропуска делегирования воркеру
              };
              downloadQueue.add(fallbackTask).catch(err => {
                if (err.message === 'TASK_TIMEOUT') {
                  console.error(`[TaskQueue] Задача отменена по таймауту (fallback): ${result.title}`);
                } else {
                  console.error('[TaskQueue] Ошибка выполнения задачи (fallback):', err.message);
                }
              });
              console.log(`[Master] ✅ Задача добавлена для локальной обработки (fallback)`);
              return; // Не отправляем сообщение об ошибке, т.к. обрабатываем локально
            } catch (e) {
              console.error(`[Master] ❌ Не удалось добавить задачу для fallback: ${e.message}`);
            }
          }
          
          // Если не удалось обработать локально — уведомляем пользователя
          await bot.telegram.sendMessage(
            result.userId,
            `❌ Не удалось скачать "${result.title}"\n\n${errorMsg || 'Попробуйте позже'}`
          ).catch(() => {});
        }
      } catch (e) {
        console.error('[Master] Ошибка обработки результата:', e.message);
      }
    });
    
  } else {
    console.log('[DownloadManager] ⚠️ TaskBroker не подключён — Spotify задачи будут обрабатываться локально');
  }
  
  console.log('[DownloadManager] Готов к работе.');
}