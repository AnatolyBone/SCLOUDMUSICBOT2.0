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

// ========================= STARTUP CHECKS =========================

console.log('╔════════════════════════════════════════════╗');
console.log('║      🎵 Music Worker for HuggingFace       ║');
console.log('╚════════════════════════════════════════════╝\n');

console.log('📋 Environment check:');
console.log(`   REDIS_URL: ${REDIS_URL ? '✅ Set (' + REDIS_URL.slice(0, 30) + '...)' : '❌ Missing!'}`);
console.log(`   BOT_TOKEN: ${BOT_TOKEN ? '✅ Set' : '❌ Missing!'}`);
console.log(`   STORAGE_CHANNEL_ID: ${STORAGE_CHANNEL_ID ? '✅ Set (' + STORAGE_CHANNEL_ID + ')' : '❌ Missing!'}`);
console.log(`   TEMP_DIR: ${TEMP_DIR}`);
console.log(`   RAM: ${Math.round(os.totalmem() / 1024 / 1024)} MB`);
console.log(`   CPUs: ${os.cpus().length}`);
console.log('');

if (!REDIS_URL || !BOT_TOKEN || !STORAGE_CHANNEL_ID) {
  console.error('❌ Missing required environment variables!');
  console.error('');
  console.error('Required in HuggingFace Secrets:');
  console.error('  - REDIS_URL (format: rediss://default:xxx@xxx.upstash.io:6379)');
  console.error('  - BOT_TOKEN (your Telegram bot token)');
  console.error('  - STORAGE_CHANNEL_ID (e.g., -1001234567890)');
  process.exit(1);
}

// ========================= INIT =========================

// Создаём папку для временных файлов
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  console.log(`📁 Created temp directory: ${TEMP_DIR}`);
}

// Redis с правильными настройками для Upstash
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 1000,
  connectTimeout: 10000,
  lazyConnect: true,
  // TLS включается автоматически для rediss://
});

redis.on('error', (err) => {
  console.error('❌ Redis error:', err.message);
});

redis.on('connect', () => {
  console.log('✅ Redis connected!');
});

const bot = new Telegraf(BOT_TOKEN);

// Express для health check
const app = express();

app.get('/', (req, res) => {
  res.json({
    status: 'running',
    uptime: Math.round(process.uptime()),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
    redis: redis.status
  });
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

function cleanupTempFiles() {
  try {
    const files = fs.readdirSync(TEMP_DIR);
    const now = Date.now();
    let cleaned = 0;
    
    files.forEach(file => {
      const filePath = path.join(TEMP_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > 10 * 60 * 1000) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch (e) {}
    });
    
    if (cleaned > 0) {
      console.log(`🧹 Cleaned ${cleaned} old files`);
    }
  } catch (e) {}
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
      '--retries', '3'
    ];

    console.log(`⬇️  Downloading: "${searchQuery.slice(0, 50)}..." (${bitrate})`);
    
    const proc = spawn('python3', args, { cwd: TEMP_DIR });
    let stderr = '';
    
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    
    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`❌ yt-dlp error: ${stderr.slice(-200)}`);
        return reject(new Error(stderr.slice(-200) || `Exit code ${code}`));
      }
      
      const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(baseName));
      if (files.length === 0) {
        return reject(new Error('File not created'));
      }
      
      const filePath = path.join(TEMP_DIR, files[0]);
      console.log(`✅ Downloaded: ${formatBytes(fs.statSync(filePath).size)}`);
      resolve(filePath);
    });
    
    proc.on('error', reject);
    
    // Таймаут
    setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('TIMEOUT'));
    }, 180000);
  });
}

// ========================= PROCESS TASK =========================

async function processTask(task) {
  const { metadata, quality, userId, cacheKey, taskId } = task;
  const searchQuery = `${metadata.uploader} ${metadata.title}`;
  
  console.log(`\n🎵 Processing: "${metadata.title}"`);
  console.log(`   Artist: ${metadata.uploader}, Quality: ${quality}`);

  let filePath = null;
  
  try {
    filePath = await downloadTrack(searchQuery, quality);
    const stats = fs.statSync(filePath);
    
    if (stats.size > 48 * 1024 * 1024) {
      throw new Error('FILE_TOO_LARGE');
    }
    
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
    console.log(`✅ Uploaded! file_id: ${fileId?.slice(0, 25)}...`);

    return {
      success: true,
      fileId,
      title: metadata.title,
      artist: metadata.uploader,
      duration: sentMsg.audio?.duration || metadata.duration,
      quality,
      cacheKey,
      userId,
      statusMessageId: task.statusMessageId // Передаём для удаления
    };

  } catch (err) {
    console.error(`❌ Failed: ${err.message}`);
    return {
      success: false,
      error: err.message,
      title: metadata?.title || 'Unknown',
      userId
    };
    
  } finally {
    if (filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) {}
    }
  }
}

// ========================= MAIN LOOP =========================

async function workerLoop() {
  console.log('👂 Listening for tasks...\n');

  while (true) {
    try {
      const result = await redis.brpop(QUEUE_KEY, 30);
      
      if (!result) continue;

      const task = JSON.parse(result[1]);
      console.log(`📥 Task received: ${task.taskId}`);

      const taskResult = await processTask(task);

      await redis.publish(RESULTS_KEY, JSON.stringify({
        taskId: task.taskId,
        ...taskResult
      }));

      console.log(`📤 Result sent\n`);

    } catch (err) {
      console.error('❌ Loop error:', err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ========================= STARTUP =========================

async function main() {
  // HTTP сервер для health check
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Health server on port ${PORT}`);
  });

  // Подключение к Redis
  console.log('🔗 Connecting to Redis...');
  try {
    await redis.connect();
    console.log('✅ Redis connected!');
    
    // Проверка подключения
    const pong = await redis.ping();
    console.log(`📡 Redis PING: ${pong}`);
    
  } catch (err) {
    console.error('❌ Redis connection failed:', err.message);
    console.error('');
    console.error('Check your REDIS_URL format:');
    console.error('  Expected: rediss://default:xxx@xxx.upstash.io:6379');
    console.error(`  Got: ${REDIS_URL?.slice(0, 50)}...`);
    process.exit(1);
  }

  // Heartbeat
  const heartbeat = async () => {
    try {
      await redis.set(HEARTBEAT_KEY, Date.now().toString(), 'EX', 120);
    } catch (e) {
      console.error('Heartbeat error:', e.message);
    }
  };
  
  setInterval(heartbeat, 30000);
  await heartbeat();
  console.log('💓 Heartbeat started');

  // Cleanup
  setInterval(cleanupTempFiles, 5 * 60 * 1000);

  // Main loop
  console.log('');
  await workerLoop();
}

// Shutdown
process.on('SIGTERM', async () => {
  console.log('\n👋 Shutting down...');
  await redis.quit();
  process.exit(0);
});

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

