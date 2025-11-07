// services/ultraFastDownloader.js
// ⚡ УЛЬТРА-БЫСТРЫЙ ЗАГРУЗЧИК ДЛЯ SOUNDCLOUD

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { PassThrough } from 'stream';
import scdl from 'soundcloud-downloader';
import ytdl from 'youtube-dl-exec';
import pMap from 'p-map';

import { bot } from '../bot.js';
import * as db from '../db.js';
import { STORAGE_CHANNEL_ID, CHANNEL_USERNAME } from '../config.js';
import { T } from '../config/texts.js';

// ========================= КОНФИГУРАЦИЯ =========================

const TEMP_DIR = path.join(os.tmpdir(), 'ultrafast-cache');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const MAX_PARALLEL_DOWNLOADS = 3; // Параллельные загрузки
const CACHE_TTL = 3600000; // 1 час в миллисекундах
const MAX_FILE_SIZE = 49 * 1024 * 1024; // 49MB

// Глобальный кэш в памяти для мгновенного доступа
const memoryCache = new Map();

// ========================= УТИЛИТЫ =========================

/**
 * Генерирует уникальный ключ кэша
 */
function getCacheKey(url, metadata = null) {
  if (metadata?.id) return `sc:${metadata.id}`;
  
  // Создаем хеш из URL для консистентности
  const hash = crypto.createHash('md5').update(url).digest('hex');
  return `url:${hash}`;
}

/**
 * Очищает старые временные файлы
 */
async function cleanupTempFiles() {
  try {
    const files = await fs.promises.readdir(TEMP_DIR);
    const now = Date.now();
    
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      const stats = await fs.promises.stat(filePath);
      
      // Удаляем файлы старше 1 часа
      if (now - stats.mtimeMs > CACHE_TTL) {
        await fs.promises.unlink(filePath);
        console.log(`🗑 Удален старый файл: ${file}`);
      }
    }
  } catch (err) {
    console.error('Ошибка очистки temp файлов:', err);
  }
}

// Запускаем очистку каждые 30 минут
setInterval(cleanupTempFiles, 1800000);

/**
 * Быстрая проверка в памяти
 */
function getFromMemoryCache(key) {
  const cached = memoryCache.get(key);
  if (!cached) return null;
  
  // Проверяем TTL
  if (Date.now() - cached.timestamp > CACHE_TTL) {
    memoryCache.delete(key);
    return null;
  }
  
  return cached.data;
}

/**
 * Сохранение в память
 */
function saveToMemoryCache(key, data) {
  // Ограничиваем размер кэша
  if (memoryCache.size > 1000) {
    // Удаляем самые старые записи
    const firstKey = memoryCache.keys().next().value;
    memoryCache.delete(firstKey);
  }
  
  memoryCache.set(key, {
    data,
    timestamp: Date.now()
  });
}

// ========================= ОСНОВНОЙ ПРОЦЕССОР =========================

/**
 * ⚡ УЛЬТРА-БЫСТРЫЙ процессор загрузки
 */
export async function ultraFastProcessor(task) {
  const { userId, url, metadata } = task;
  const startTime = Date.now();
  
  try {
    // 1. ПРОВЕРКА КЭША В ПАМЯТИ (0ms)
    const cacheKey = getCacheKey(url, metadata);
    const memoryCached = getFromMemoryCache(cacheKey);
    
    if (memoryCached?.fileId) {
      console.log(`⚡ MEMORY CACHE HIT за ${Date.now() - startTime}ms`);
      await bot.telegram.sendAudio(userId, memoryCached.fileId, {
        title: memoryCached.title,
        performer: memoryCached.artist,
        duration: memoryCached.duration
      });
      return { success: true, cached: true, time: Date.now() - startTime };
    }
    
    // 2. ПРОВЕРКА КЭША В БД (5-10ms)
    const dbCached = await db.findCachedTrack(cacheKey) || await db.findCachedTrack(url);
    
    if (dbCached?.fileId) {
      console.log(`💾 DB CACHE HIT за ${Date.now() - startTime}ms`);
      
      // Сохраняем в память для следующего раза
      saveToMemoryCache(cacheKey, dbCached);
      
      await bot.telegram.sendAudio(userId, dbCached.fileId, {
        title: dbCached.trackName,
        performer: dbCached.artist,
        duration: dbCached.duration
      });
      return { success: true, cached: true, time: Date.now() - startTime };
    }
    
    // 3. ЗАГРУЗКА (оптимизированная)
    console.log(`📥 Загружаю новый трек: ${metadata?.title || url}`);
    
    // Создаем временный файл
    const tempFile = path.join(TEMP_DIR, `${crypto.randomBytes(16).toString('hex')}.mp3`);
    
    try {
      // Получаем поток
      const stream = await scdl.download(url);
      
      // Используем двойной поток для одновременной записи и отправки
      if (STORAGE_CHANNEL_ID) {
        // ОПТИМИЗАЦИЯ: Дублируем поток
        const [fileStream, sendStream] = duplicateStream(stream);
        
        // Параллельно: записываем в файл И отправляем в канал
        const [writeResult, sendResult] = await Promise.all([
          // Записываем в файл
          pipeline(fileStream, fs.createWriteStream(tempFile)),
          // Отправляем в канал
          bot.telegram.sendAudio(
            STORAGE_CHANNEL_ID,
            { source: sendStream },
            {
              title: metadata?.title || 'Unknown',
              performer: metadata?.uploader || 'Unknown',
              duration: metadata?.duration ? Math.round(metadata.duration) : undefined
            }
          )
        ]);
        
        const fileId = sendResult?.audio?.file_id;
        
        if (fileId) {
          // Сохраняем в БД
          const cacheData = {
            url,
            fileId,
            title: metadata?.title,
            artist: metadata?.uploader,
            duration: metadata?.duration ? Math.round(metadata.duration) : undefined,
            thumbnail: metadata?.thumbnail
          };
          
          await db.cacheTrack(cacheData);
          
          // Сохраняем в память
          saveToMemoryCache(cacheKey, {
            fileId,
            title: metadata?.title,
            artist: metadata?.uploader,
            duration: metadata?.duration ? Math.round(metadata.duration) : undefined
          });
          
          // Отправляем юзеру через file_id (БЫСТРО!)
          await bot.telegram.sendAudio(userId, fileId, {
            title: metadata?.title,
            performer: metadata?.uploader,
            duration: metadata?.duration ? Math.round(metadata.duration) : undefined
          });
          
          console.log(`✅ Обработано за ${Date.now() - startTime}ms`);
          return { success: true, cached: false, time: Date.now() - startTime };
        }
      } else {
        // Если нет канала хранилища - отправляем напрямую
        await pipeline(stream, fs.createWriteStream(tempFile));
        
        const message = await bot.telegram.sendAudio(
          userId,
          { source: fs.createReadStream(tempFile) },
          {
            title: metadata?.title,
            performer: metadata?.uploader,
            duration: metadata?.duration ? Math.round(metadata.duration) : undefined
          }
        );
        
        console.log(`✅ Отправлено напрямую за ${Date.now() - startTime}ms`);
        return { success: true, cached: false, time: Date.now() - startTime };
      }
      
    } finally {
      // Асинхронная очистка (не блокируем)
      fs.unlink(tempFile, () => {});
    }
    
  } catch (err) {
    console.error(`❌ Ошибка для user ${userId}:`, err);
    throw err;
  }
}

/**
 * Дублирует поток для параллельной обработки
 */
function duplicateStream(source) {
  const stream1 = new PassThrough();
  const stream2 = new PassThrough();
  
  source.on('data', chunk => {
    stream1.write(chunk);
    stream2.write(chunk);
  });
  
  source.on('end', () => {
    stream1.end();
    stream2.end();
  });
  
  source.on('error', err => {
    stream1.destroy(err);
    stream2.destroy(err);
  });
  
  return [stream1, stream2];
}

// ========================= ПАКЕТНАЯ ОБРАБОТКА =========================

/**
 * Обработка плейлиста с параллельной загрузкой
 */
export async function processPlaylistUltraFast(userId, tracks) {
  console.log(`🎵 Обработка плейлиста из ${tracks.length} треков`);
  
  const results = {
    fromCache: 0,
    downloaded: 0,
    failed: 0,
    totalTime: 0
  };
  
  const startTime = Date.now();
  
  // Обрабатываем батчами для оптимальной производительности
  await pMap(
    tracks,
    async (track) => {
      try {
        const result = await ultraFastProcessor({
          userId,
          url: track.url,
          metadata: track.metadata
        });
        
        if (result.cached) {
          results.fromCache++;
        } else {
          results.downloaded++;
        }
        
        results.totalTime += result.time;
        
      } catch (err) {
        results.failed++;
        console.error(`Ошибка трека ${track.url}:`, err.message);
      }
    },
    { concurrency: MAX_PARALLEL_DOWNLOADS }
  );
  
  const totalTime = Date.now() - startTime;
  
  console.log(`✅ Плейлист обработан за ${totalTime}ms`);
  console.log(`   Из кэша: ${results.fromCache}`);
  console.log(`   Загружено: ${results.downloaded}`);
  console.log(`   Ошибок: ${results.failed}`);
  console.log(`   Среднее время/трек: ${Math.round(results.totalTime / tracks.length)}ms`);
  
  return results;
}

// ========================= ИНТЕЛЛЕКТУАЛЬНЫЙ КЭШ =========================

class SmartCache {
  constructor() {
    this.hotTracks = new Map(); // Популярные треки
    this.preloadQueue = [];
    this.isPreloading = false;
  }
  
  /**
   * Предзагрузка популярных треков
   */
  async preloadPopular() {
    if (this.isPreloading) return;
    this.isPreloading = true;
    
    try {
      // Получаем топ треки из БД
      const popularTracks = await db.getPopularTracks(20);
      
      for (const track of popularTracks) {
        if (!this.hotTracks.has(track.url)) {
          this.preloadQueue.push(track);
        }
      }
      
      // Фоновая загрузка
      this.processPreloadQueue();
      
    } catch (err) {
      console.error('Ошибка предзагрузки:', err);
    } finally {
      this.isPreloading = false;
    }
  }
  
  async processPreloadQueue() {
    while (this.preloadQueue.length > 0) {
      const track = this.preloadQueue.shift();
      
      try {
        // Проверяем, есть ли уже в кэше
        const cached = await db.findCachedTrack(track.url);
        if (!cached) {
          console.log(`🔥 Предзагрузка: ${track.title}`);
          
          // Загружаем в фоне
          await ultraFastProcessor({
            userId: STORAGE_CHANNEL_ID, // Используем канал как "системного юзера"
            url: track.url,
            metadata: track
          });
        }
        
        this.hotTracks.set(track.url, true);
        
        // Небольшая пауза между загрузками
        await new Promise(r => setTimeout(r, 1000));
        
      } catch (err) {
        console.error(`Ошибка предзагрузки ${track.url}:`, err.message);
      }
    }
  }
}

export const smartCache = new SmartCache();

// ========================= ГЛАВНАЯ ФУНКЦИЯ ВХОДА =========================

/**
 * Основная функция для обработки запроса пользователя
 */
export async function processUltraFast(userId, url) {
  const startTime = Date.now();
  
  try {
    // 1. Быстрая проверка в памяти
    const cacheKey = getCacheKey(url);
    const memoryCached = getFromMemoryCache(cacheKey);
    
    if (memoryCached?.fileId) {
      await bot.telegram.sendAudio(userId, memoryCached.fileId, {
        title: memoryCached.title,
        performer: memoryCached.artist,
        duration: memoryCached.duration
      });
      
      console.log(`⚡ Отправлено из памяти за ${Date.now() - startTime}ms!`);
      return;
    }
    
    // 2. Получаем метаданные
    let metadata = null;
    try {
      const info = await ytdl(url, {
        'dump-single-json': true,
        'no-playlist': true,
        'socket-timeout': 10
      });
      
      metadata = {
        id: info.id,
        title: info.title,
        uploader: info.uploader,
        duration: info.duration,
        thumbnail: info.thumbnail,
        webpage_url: info.webpage_url
      };
    } catch (err) {
      console.warn('Не удалось получить метаданные:', err.message);
    }
    
    // 3. Обрабатываем
    await ultraFastProcessor({
      userId,
      url,
      metadata
    });
    
  } catch (err) {
    await bot.telegram.sendMessage(
      userId,
      `❌ Не удалось обработать ссылку: ${err.message}`
    );
  }
}

// ========================= АВТОЗАПУСК =========================

// Запускаем предзагрузку популярных треков при старте
setTimeout(() => {
  smartCache.preloadPopular().catch(console.error);
}, 5000);

// Обновляем популярные треки каждые 30 минут
setInterval(() => {
  smartCache.preloadPopular().catch(console.error);
}, 1800000);

// ========================= ЭКСПОРТ =========================

export default {
  processUltraFast,
  ultraFastProcessor,
  processPlaylistUltraFast,
  smartCache
};