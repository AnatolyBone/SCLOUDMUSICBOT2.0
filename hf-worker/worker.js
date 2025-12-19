// worker.js - Hugging Face Music Worker
// Получает задачи из Redis, скачивает через yt-dlp, загружает в Telegram

import Redis from 'ioredis';
import { Telegraf } from 'telegraf';
import { spawn } from 'child_process';
import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ========================= CONFIG =========================

const REDIS_URL = process.env.REDIS_URL;
const BOT_TOKEN = process.env.BOT_TOKEN;
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;
const PORT = process.env.PORT || 7860;

const QUEUE_KEY = 'music:download:queue';
const RESULTS_KEY = 'music:download:results';
const HEARTBEAT_KEY = 'music:worker:heartbeat';
const TEMP_DIR = process.env.TEMP_DIR || '/tmp/music-worker';

// Проверка конфигурации
if (!REDIS_URL || !BOT_TOKEN || !STORAGE_CHANNEL_ID) {
  console.error('❌ Missing required environment variables!');
  console.error('Required: REDIS_URL, BOT_TOKEN, STORAGE_CHANNEL_ID');
  process.exit(1);
}

// ========================= INIT =========================

// Создаём папку для временных файлов
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true
  // TLS включается автоматически для rediss://
});

const bot = new Telegraf(BOT_TOKEN);

// Express для health check (HuggingFace требует)
const app = express();

app.get('/', (req, res) => {
  const stats = {
    status: 'running',
    uptime: process.uptime(),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
    totalMemory: Math.round(os.totalmem() / 1024 / 1024) + ' MB',
    platform: os.platform(),
    arch: os.arch()
  };
  res.json(stats);
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ========================= HELPERS =========================

function formatBytes(bytes) {
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '').slice(0, 100);
}

// Очистка старых файлов
function cleanupTempFiles() {
  try {
    const files = fs.readdirSync(TEMP_DIR);
    const now = Date.now();
    let cleaned = 0;
    
    files.forEach(file => {
      const filePath = path.join(TEMP_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        // Удаляем файлы старше 10 минут
        if (now - stats.mtimeMs > 10 * 60 * 1000) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch (e) {}
    });
    
    if (cleaned > 0) {
      console.log(`🧹 Cleaned ${cleaned} old files`);
    }
  } catch (e) {
    console.error('Cleanup error:', e.message);
  }
}

// ========================= DOWNLOAD =========================

async function downloadTrack(searchQuery, quality = 'medium') {
  const bitrate = { 
    high: '320k', 
    medium: '192k', 
    low: '128k' 
  }[quality] || '192k';
  
  const baseName = `track_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const outputTemplate = path.join(TEMP_DIR, `${baseName}.%(ext)s`);

  return new Promise((resolve, reject) => {
    const args = [
      '-m', 'yt_dlp',
      `ytsearch1:${searchQuery}`,
      '-f', 'bestaudio/best',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', bitrate,
      '-o', outputTemplate,
      '--no-playlist',
      '--no-warnings',
      '--quiet',
      '--no-check-certificates',
      '--geo-bypass',
      '--retries', '3',
      '--fragment-retries', '3'
    ];

    console.log(`⬇️  Downloading: "${searchQuery.slice(0, 50)}..." (${bitrate})`);
    
    const proc = spawn('python3', args, { 
      cwd: TEMP_DIR,
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });
    
    let stderr = '';
    
    proc.stderr.on('data', (data) => { 
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`❌ yt-dlp error (code ${code}): ${stderr.slice(-300)}`);
        return reject(new Error(stderr.slice(-200) || `Exit code ${code}`));
      }
      
      // Ищем созданный файл
      const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(baseName));
      
      if (files.length === 0) {
        console.error('❌ No output file created');
        return reject(new Error('File not created'));
      }
      
      const filePath = path.join(TEMP_DIR, files[0]);
      const stats = fs.statSync(filePath);
      
      console.log(`✅ Downloaded: ${formatBytes(stats.size)}`);
      resolve(filePath);
    });
    
    proc.on('error', (err) => {
      reject(new Error(`Spawn error: ${err.message}`));
    });
    
    // Таймаут 3 минуты
    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('TIMEOUT'));
    }, 180000);
    
    proc.on('close', () => clearTimeout(timeout));
  });
}

// ========================= PROCESS TASK =========================

async function processTask(task) {
  const { metadata, quality, userId, cacheKey, taskId } = task;
  const searchQuery = `${metadata.uploader} ${metadata.title}`;
  
  console.log(`\n🎵 Processing: "${metadata.title}" by ${metadata.uploader}`);
  console.log(`   Quality: ${quality}, User: ${userId}`);

  let filePath = null;
  
  try {
    // 1. Скачиваем
    filePath = await downloadTrack(searchQuery, quality);
    const stats = fs.statSync(filePath);
    
    // 2. Проверяем размер (Telegram лимит ~50 MB)
    if (stats.size > 48 * 1024 * 1024) {
      console.warn(`⚠️ File too large: ${formatBytes(stats.size)}`);
      throw new Error('FILE_TOO_LARGE');
    }
    
    // 3. Загружаем в Telegram Storage
    console.log(`📤 Uploading to Telegram...`);
    
    const sentMsg = await bot.telegram.sendAudio(
      STORAGE_CHANNEL_ID,
      { source: fs.createReadStream(filePath) },
      {
        title: metadata.title,
        performer: metadata.uploader,
        duration: metadata.duration || undefined,
        disable_notification: true
      }
    );

    const fileId = sentMsg.audio?.file_id;
    const actualDuration = sentMsg.audio?.duration;
    
    console.log(`✅ Uploaded! file_id: ${fileId?.slice(0, 25)}...`);

    return {
      success: true,
      fileId,
      title: metadata.title,
      artist: metadata.uploader,
      duration: actualDuration || metadata.duration,
      quality,
      cacheKey,
      userId
    };

  } catch (err) {
    console.error(`❌ Task failed: ${err.message}`);
    
    return {
      success: false,
      error: err.message,
      title: metadata?.title || 'Unknown',
      userId
    };
    
  } finally {
    // 4. Удаляем временный файл
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log(`🗑️  Temp file deleted`);
      } catch (e) {}
    }
  }
}

// ========================= MAIN LOOP =========================

async function workerLoop() {
  console.log('👂 Waiting for tasks...\n');

  while (true) {
    try {
      // Блокирующее ожидание задачи (до 30 сек)
      const result = await redis.brpop(QUEUE_KEY, 30);
      
      if (!result) {
        // Таймаут — продолжаем ждать
        continue;
      }

      const task = JSON.parse(result[1]);
      console.log(`📥 Received task: ${task.taskId}`);

      // Обрабатываем задачу
      const taskResult = await processTask(task);

      // Отправляем результат обратно
      await redis.publish(RESULTS_KEY, JSON.stringify({
        taskId: task.taskId,
        ...taskResult
      }));

      console.log(`📤 Result published for task: ${task.taskId}\n`);

    } catch (err) {
      console.error('❌ Worker loop error:', err.message);
      
      // Переподключаемся к Redis если потеряли связь
      if (err.message.includes('ECONNREFUSED') || err.message.includes('READONLY')) {
        console.log('🔄 Reconnecting to Redis...');
        await new Promise(r => setTimeout(r, 5000));
      } else {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
}

// ========================= STARTUP =========================

async function main() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║      🎵 Music Worker for HuggingFace       ║');
  console.log('╠════════════════════════════════════════════╣');
  console.log(`║  RAM: ${Math.round(os.totalmem() / 1024 / 1024).toString().padStart(6)} MB                        ║`);
  console.log(`║  CPU: ${os.cpus().length.toString().padStart(6)} cores                       ║`);
  console.log(`║  Platform: ${os.platform().padEnd(10)}                   ║`);
  console.log('╚════════════════════════════════════════════╝\n');

  // Запускаем HTTP сервер (для health check)
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Health check server on port ${PORT}`);
  });

  // Подключаемся к Redis
  try {
    await redis.connect();
    console.log('✅ Connected to Redis');
  } catch (err) {
    console.error('❌ Redis connection failed:', err.message);
    process.exit(1);
  }

  // Heartbeat каждые 30 сек
  const heartbeat = async () => {
    try {
      await redis.set(HEARTBEAT_KEY, Date.now().toString(), 'EX', 120);
    } catch (e) {}
  };
  
  setInterval(heartbeat, 30000);
  await heartbeat();
  console.log('💓 Heartbeat started');

  // Очистка временных файлов каждые 5 минут
  setInterval(cleanupTempFiles, 5 * 60 * 1000);
  cleanupTempFiles();

  // Запускаем основной цикл
  console.log('');
  await workerLoop();
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('\n👋 Shutting down...');
  await redis.quit();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

// Запуск
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

