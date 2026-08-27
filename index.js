
// index.js (продакшен-вебхук с диагностикой, быстрый дашборд, /tmp для загрузок, Referer)

import express from 'express';
import axios from 'axios';
import session from 'express-session';
import compression from 'compression';
import path from 'path';
import multer from 'multer';
import expressLayouts from 'express-ejs-layouts';
import { fileURLToPath } from 'url';
import pgSessionFactory from 'connect-pg-simple';
import fs from 'fs';
import os from 'os';
import mime from 'mime-types';
import { checkAndSendExpirationNotifications, notifyExpiringTodayHourly } from './services/notifier.js';
import { loadSettings,getAllSettings,getSetting} from './services/settingsManager.js';
import { buildUserTariffPresentation } from './services/userTariffPresentation.js';
import {
  pool,
  query,
  supabase,
  karaokePool,
  getUserById,
  resetDailyStats,
  getUserUniqueDownloadedUrls,
  fixBadCacheForUser,
  getPaginatedUsers,
  getExpiringUsers,
  setPremium,
  updateUserField,
  getDownloadsByUserId,
  getReferralsByUserId,
  getCachedTracksCount,
  getUsersCountByTariff,
  getTopReferralSources,
  getDailyStats,
  getActivityByWeekday,
  getTopTracks,
  getTopUsers,
  getHourlyActivity,
  getUsersAsCsv,
  getUserActions,
  logUserAction,
  createBroadcastTask,
  cancelBroadcastTask,
  areBroadcastsEnabled,
  setBroadcastsEnabled,
  getAllBroadcastTasks,
  deleteBroadcastTask,
  getBroadcastTaskById,
  updateBroadcastTask,
  getReferrerInfo,
  getReferredUsers,
  getReferralStats,
  resetOtherTariffsToFree,
  resetExpiredPremiumsBulk,
  getUsersTotalsSnapshot,
  setTariffAdmin,
  logBrokenTrack, 
  getBrokenTracks, 
  resolveBrokenTrack,
  deleteCachedTrack,
  getBrokenTracksWithPagination,
  deleteBrokenTrack,
  deleteBrokenTracksBulk,
  deleteAllBrokenTracks,
  incrementBrokenTrackRetry,
  setAppSetting,
  getNewUsersCount,
  getPromoCampaigns,
  getPromoCampaignById,
  isPromoMediaPathInUse,
  createPromoCampaign,
  updatePromoCampaign,
  deletePromoCampaign,
  archivePromoCampaign,
  restorePromoCampaign,
  softDeletePromoCampaign,
  resetSystemPromoCampaign,
  writeAdCampaignAudit,
  getPromoStats,
  getPromoCreativeStats,
  getPromoTriggerStats,
  getDashboardPromoCampaignStats,
  resetPromoCampaign,
  runSupportSystemMigration,
  runAnalyticsSystemMigration,
  runMultilangSystemMigration,
  runPreflightFixesMigration,
  checkSchemaPreflight,
  createSupportMessage,
  getSupportMessageById,
  getSupportTickets,
  getSupportMessages,
  markSupportMessagesAsRead,
  deleteSupportMessages,
  getUnreadSupportTicketsCount,
  aggregateDailyStats,
  backfillMissingDays
} from './db.js';
import { initializeWorkers } from './services/workerManager.js';
import { runBroadcastBatch } from './services/broadcastManager.js';
import { isShuttingDown, setShuttingDown, setMaintenanceMode, isMaintenanceMode } from './services/appState.js';
import { bot } from './bot.js';
import { resolveUserIdentifier } from './services/userResolver.js';
import { resolveSupportImage, validateSupportImage } from './services/supportMediaService.js';
import { normalizePromoKey, PROMO_CATEGORIES } from './services/promoCampaignService.js';
import { AD_CAMPAIGN_MEDIA_BUCKET, createAdCampaignMediaSignedUrl, removeAdCampaignMediaSafely, uploadAdCampaignMedia } from './services/adCampaignMediaService.js';
import redisService from './services/redisClient.js';
import {
  WEBHOOK_URL, PORT, SESSION_SECRET, ADMIN_ID, ADMIN_LOGIN, ADMIN_PASSWORD,
  WEBHOOK_PATH, STORAGE_CHANNEL_ID, BROADCAST_STORAGE_ID
} from './config.js';
import { loadTexts, setText, getEditableTexts } from './config/texts.js';
import { downloadQueue, initializeDownloadManager, applyDownloadWorkerSettings } from './services/downloadManager.js';
import { runAnalyticsSmokeTest } from './services/analyticsSmokeTest.js';
import { generateExcelReport } from './services/excelReportService.js';
import { formatSettingForLog, sanitizeLogValue } from './services/logSanitizer.js';
import { shiftAnalyticsDay } from './services/analyticsBackfillService.js';
import { runSystemSelfTest } from './services/systemSelfTest.js';
import { mapBroadcastTaskToForm } from './services/broadcastFormMapper.js';
import {
  issueBroadcastLaunchToken,
  sendBroadcastPreview,
  validateBroadcastLaunchRequest
} from './services/broadcastSafety.js';

const app = express();

// Храним временные файлы в /tmp (на Render быстрее)
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dest = path.join(os.tmpdir(), 'uploads');
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 49 * 1024 * 1024 } });
const promoMediaUpload = multer({ storage:multer.memoryStorage(), limits:{fileSize:20*1024*1024} });
const handlePromoMediaUpload = (req,res,next) => promoMediaUpload.single('media')(req,res,error => {
  if (!error) return next();
  const message = error.code === 'LIMIT_FILE_SIZE' ? 'Файл превышает максимально допустимые 20 МБ.' : `Ошибка загрузки файла: ${error.message}`;
  res.redirect(`/promos?error=${encodeURIComponent(message)}`);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// index.js -> startApp()

async function startApp() {
  console.log('[App] Запуск приложения...');
  const forcePolling = process.env.FORCE_POLLING === '1';
  const skipStartupMigrations = process.env.SKIP_STARTUP_MIGRATIONS === '1';

  try {
    setupExpress();
    if (skipStartupMigrations) {
      console.log('[DB] Startup migrations skipped by SKIP_STARTUP_MIGRATIONS=1.');
    } else {
      await runSupportSystemMigration();
      await runAnalyticsSystemMigration();
      await runMultilangSystemMigration();
      await runPreflightFixesMigration();
    }
    await checkSchemaPreflight({ throwOnMissing: true });

    // Историческая миграция лимитов (удалена, чтобы настройки пользователя не перезаписывались при старте)
    
    // Остальная инициализация
    await loadTexts(true);
    await redisService.connect();
    await loadSettings();
    await redisService.subscribe('settings:invalidate', () => loadSettings().catch(error => {
      console.error('[Settings] Redis refresh failed:', error.message);
    }));
    const settingsRefreshTimer = setInterval(() => loadSettings().catch(error => {
      console.error('[Settings] Background refresh failed:', error.message);
    }), 15_000);
    settingsRefreshTimer.unref?.();
    
    // Восстановление от MAX(day)+1 до вчера с защитным лимитом.
    backfillMissingDays().catch(e => console.error('[Startup/Backfill] Ошибка:', e.message));

    await initializeDownloadManager();

    // Не открываем HTTP-порт, пока критичный контракт PostgreSQL не подтверждён.
    const server = app.listen(PORT, () => console.log(`✅ [App] Сервер запущен на порту ${PORT}.`));
    
    let lastUpdateTs = Date.now();
    bot.use((ctx, next) => { lastUpdateTs = Date.now(); return next(); });
    
    downloadQueue.start();
    console.log('[App] Очередь скачивания принудительно запущена.');
    
    let EXPECTED_WEBHOOK = null;
    
    if (process.env.NODE_ENV === 'production' && !forcePolling) {
      const fullBase = WEBHOOK_URL.endsWith('/') ? WEBHOOK_URL.slice(0, -1) : WEBHOOK_URL;
      const fullWebhookUrl = fullBase + WEBHOOK_PATH;
      const allowedUpdates = ['message', 'callback_query', 'inline_query', 'chosen_inline_result', 'pre_checkout_query'];
      
      // Retry-логика для вебхука
      for (let i = 0; i < 3; i++) {
        try {
          console.log(`[App] Попытка ${i + 1}/3: устанавливаю вебхук...`);
          await bot.telegram.setWebhook(fullWebhookUrl, {
            drop_pending_updates: true,
            allowed_updates: allowedUpdates
          });
          console.log('[App] ✅ Вебхук успешно настроен.');
          break; // Успех, выходим из цикла
        } catch (e) {
          console.error(`[App] ❌ Ошибка установки вебхука (попытка ${i + 1}):`, e.message);
          if (i < 2) {
            await new Promise(r => setTimeout(r, 5000)); // Ждём 5 секунд
          } else {
            throw new Error('Не удалось установить вебхук после 3 попыток.'); // Все попытки провалились
          }
        }
      }
      
      EXPECTED_WEBHOOK = fullWebhookUrl;
      
      // Логируем состояние вебхука
      try {
        const info = await bot.telegram.getWebhookInfo();
        console.log('[WebhookInfo]', JSON.stringify(info, null, 2));
      } catch (e) {
        console.warn('[WebhookInfo] Ошибка получения информации:', e.message);
      }
      
      // Маршрут вебхука
      app.post(
        WEBHOOK_PATH,
        express.json({ limit: '1mb' }),
        (req, res, next) => {
          try {
            const u = req.body || {};
            const type =
              u.message ? 'message' :
              u.callback_query ? 'callback_query' :
              u.inline_query ? 'inline_query' :
              Object.keys(u).filter(k => k !== 'update_id')[0] || 'unknown';
            console.log(`[Webhook] Update ${u.update_id || '-'} type=${type}`);
          } catch {}
          next();
        },
        bot.webhookCallback(WEBHOOK_PATH)
      );
      
    } else {
      // Режим long-polling (для разработки)
      console.log('[App] Запуск бота в режиме long-polling...');
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      bot.launch({
        allowedUpdates: ['message', 'callback_query', 'inline_query', 'chosen_inline_result', 'pre_checkout_query']
      });
    }
    
    // Диагностический роут для просмотра состояния вебхука (требует авторизации)
    app.get('/debug/webhook', (req, res, next) => {
      if (req.session?.authenticated && req.session?.userId === ADMIN_ID) return next();
      res.status(403).send('Forbidden');
    }, async (req, res) => {
      try {
        const info = await bot.telegram.getWebhookInfo();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(info, null, 2));
      } catch (e) {
        res.status(500).send(e.message);
      }
    });
    
    // Инициализируем воркеры и фоновые задачи
    initializeWorkers(server, bot);
    
    console.log('[App] Настройка фоновых задач...');
    setInterval(() => {
      checkAndSendExpirationNotifications(bot).catch(e => {
        console.error('[Cron] Ошибка дневного нотификатора:', e.message);
      });
    }, 60000);
    
    setInterval(() => {
      notifyExpiringTodayHourly(bot).catch(e => {
        console.error('[Cron] Ошибка почасового нотификатора:', e.message);
      });
    }, 3600000);
    
    console.log('[App] Нотификаторы истечения подписок запущены.');
    
    setInterval(async () => {
      try { await resetDailyStats(); } catch (e) { console.error('[Cron] resetDailyStats error:', e.message); }
    }, 24 * 3600 * 1000);
    
    // Ежедневный автоматический сброс истёкших подписок
    setInterval(async () => {
      try {
        const count = await resetExpiredPremiumsBulk();
        if (count > 0) console.log(`[Cron] Автоматический сброс подписок: понижено до Free ${count} пользователей.`);
      } catch (e) {
        console.error('[Cron] Ошибка автоматического сброса подписок:', e.message);
      }
    }, 24 * 3600 * 1000);

    // Ежедневная агрегация после 00:05 МСК. Catch-up условие позволяет
    // выполнить её после рестарта или простоя процесса в точную минуту запуска.
    let lastAggregationDate = null;
    let lastAggregationAttemptAt = 0;
    const aggregationRetryMs = 5 * 60 * 1000;
    setInterval(async () => {
      try {
        const nowMsk = new Date().toLocaleString('en-CA', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hour12: false });
        const todayMsk = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
        const [hh, mm] = nowMsk.split(':').map(Number);
        const afterScheduledTime = hh > 0 || (hh === 0 && mm >= 5);
        const targetDay = shiftAnalyticsDay(todayMsk, -1);
        const retryReady = Date.now() - lastAggregationAttemptAt >= aggregationRetryMs;
        if (afterScheduledTime && lastAggregationDate !== targetDay && retryReady) {
          lastAggregationAttemptAt = Date.now();
          console.log(`[Cron] Запуск агрегации аналитики за ${targetDay}...`);
          const result = await aggregateDailyStats(targetDay);
          if (result?.status === 'aggregated') {
            lastAggregationDate = targetDay;
            console.log(`[Cron] Агрегация аналитики за ${targetDay} завершена.`);
          } else {
            console.warn(`[Cron] Агрегация за ${targetDay} не завершена (${result?.status || 'unknown'}); повтор через 5 минут.`);
          }
        }
      } catch (e) {
        console.error(`[Cron] Ошибка агрегации аналитики; повтор не ранее чем через 5 минут: ${e.message}`);
      }
    }, 60 * 1000); // каждую минуту

    // Разовый запуск сброса подписок при старте сервера
    resetExpiredPremiumsBulk().then(count => {
      if (count > 0) console.log(`[Startup] Автоматически сброшено ${count} истёкших подписок.`);
    }).catch(e => {
      console.error('[Startup] Ошибка сброса подписок при запуске:', e.message);
    });
    
    setInterval(() => console.log(`[Monitor] Очередь: ${downloadQueue.size} в ожидании, ${downloadQueue.pending} в работе.`), 60000);
    
    // Watchdog вебхука
    if (EXPECTED_WEBHOOK) {
      setInterval(async () => {
        try {
          const info = await bot.telegram.getWebhookInfo();
          const hasError = Boolean(info.last_error_date);
          const urlMismatch = info.url !== EXPECTED_WEBHOOK;
          if (hasError || urlMismatch) {
            console.warn('[WebhookWatch] Проблема с вебхуком:', {
              currentUrl: info.url,
              last_error_message: info.last_error_message,
              last_error_date: info.last_error_date
            });
            await bot.telegram.setWebhook(EXPECTED_WEBHOOK);
            console.log('[WebhookWatch] Вебхук переустановлен.');
          }
        } catch (e) {
          console.error('[WebhookWatch] Ошибка проверки вебхука:', e.message);
        }
      }, 10 * 60 * 1000);
      
      setInterval(async () => {
        if (Date.now() - lastUpdateTs > 15 * 60 * 1000) {
          console.warn('[WebhookWatch] Давно не было апдейтов, переустанавливаю вебхук...');
          try { await bot.telegram.setWebhook(EXPECTED_WEBHOOK); } catch (e) {}
          lastUpdateTs = Date.now();
        }
      }, 5 * 60 * 1000);
    }
  } catch (err) {
    console.error('🔴 Критическая ошибка при запуске:', err);
    process.exit(1);
  }
}
function parseButtons(buttonsText) {
  if (!buttonsText || typeof buttonsText !== 'string' || buttonsText.trim() === '') {
    return null;
  }
  const rows = buttonsText.split('\n').map(line => line.trim()).filter(line => line);
  const keyboard = rows.map(row => {
    const parts = row.split('|').map(p => p.trim());
    const [text, type, data] = parts;
    if (!text || !type) return null;

    switch (type.toLowerCase()) {
      case 'url': return { text, url: data };
      case 'callback': return { text, callback_data: data };
      case 'inline_search': return { text, switch_inline_query: data || '' };
      default: return null;
    }
  }).filter(Boolean);

  return keyboard.length > 0 ? keyboard.map(button => [button]) : null;
}

function setupExpress() {
  console.log('[Express] Настройка Express сервера...');
  app.set('trust proxy', 1);
  app.use(compression({ threshold: 1024 }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));

  app.use('/static', express.static(path.join(__dirname, 'public', 'static'), {
    maxAge: '1h',
    etag: true
  }));

  app.use(expressLayouts);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('layout', 'layout');

  const pgSession = pgSessionFactory(session);
  app.use(session({
    store: new pgSession({ pool, tableName: 'session' }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax'
    }
  }));

  app.use(async (req, res, next) => {
    res.locals.user = null;
    res.locals.page = '';
    res.locals.unreadSupportCount = 0;
    res.locals.getSetting = getSetting;
    if (req.session.authenticated && req.session.userId === ADMIN_ID) {
      try { 
        res.locals.user = await getUserById(req.session.userId); 
        res.locals.unreadSupportCount = await getUnreadSupportTicketsCount();
      } catch {}
    }
    next();
  });

  const requireAuth = (req, res, next) => {
    if (req.session.authenticated && req.session.userId === ADMIN_ID) return next();
    res.redirect('/admin');
  };

app.get('/health', async (req, res) => {
  try {
    const redisAvailable = await redisService.isAvailable();
    // Добавляем проверку, чтобы не крашилось, если pool не определен
    const dbAvailable = pool ? await pool.query('SELECT 1').then(() => true).catch(() => false) : false;
    
    const health = {
      status: 'ok', // Всегда пишем ok для Render
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      services: {
        redis: redisAvailable ? '✅' : '⚠️ (Disabled)', // Помечаем как отключенный, а не ошибку
        database: dbAvailable ? '✅' : '❌',
        downloadQueue: (downloadQueue && downloadQueue.size > 0) ? `⏳ ${downloadQueue.size} в очереди` : '✅'
      }
    };
    
    // ИЗМЕНЕНИЕ ЗДЕСЬ:
    // Render требует статус 200 для прохождения проверки.
    // Мы отправляем 200, даже если Redis выключен, так как бот работает и без него.
    res.status(200).json(health);

  } catch (e) {
    // А вот если произошел реальный сбой (ошибка в коде), тогда 500
    console.error('Health check failed:', e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/r', async (req, res) => {
  try {
    const { t } = req.query;
    if (!t) {
      return res.redirect('https://t.me/SCloudMusicBot');
    }

    const { verifyRedirectToken } = await import('./services/cryptoService.js');
    const payload = verifyRedirectToken(t);
    if (!payload) {
      console.warn(`[Redirect] Invalid or expired token: ${t}`);
      return res.redirect('https://t.me/SCloudMusicBot');
    }

    const campaignId = parseInt(payload.c, 10);
    const userId = payload.u ? payload.u.toString() : null;
    const buttonIndex = parseInt(payload.b, 10);
    
    let destUrl = payload.url;
    let redirectUser = null;

    // Если это реальная рассылка (campaignId > 0), URL назначения нужно извлечь из кнопки задачи
    if (!destUrl && campaignId > 0) {
      const task = await getBroadcastTaskById(campaignId);
      if (task) {
        let lang = task.fallback_language || 'ru';
        if (userId) {
          redirectUser = await getUserById(userId);
          if (redirectUser?.language_code) lang = redirectUser.language_code;
        }
        
        const langData = task.messages_json?.[lang] || task.messages_json?.[task.fallback_language || 'ru'] || task.messages_json?.['ru'] || {};
        const keyboard = langData.keyboard || task.keyboard || [];
        const flatKeyboard = keyboard.flat();
        const button = flatKeyboard[buttonIndex];
        if (button && button.url) {
          destUrl = button.url;
        }
      }
    }

    if (!destUrl) {
      console.warn(`[Redirect] Destination URL not found for campaign ${campaignId}, button ${buttonIndex}`);
      return res.redirect('https://t.me/SCloudMusicBot');
    }

    // Логируем клик в broadcast_clicks
    if (campaignId > 0 && userId) {
      if (!redirectUser) redirectUser = await getUserById(userId);
      await pool.query(
        `INSERT INTO broadcast_clicks (campaign_id, user_id, button_index, clicked_at, user_agent, language_code)
         VALUES ($1, $2, $3, NOW(), $4, $5)
         ON CONFLICT DO NOTHING`,
        [campaignId, userId, buttonIndex, req.get('user-agent') || null, redirectUser?.language_code || null]
      ).catch(err => {
        console.error('[Redirect] Error logging click:', err.message);
      });
    }

    return res.redirect(destUrl);
  } catch (err) {
    console.error('[Redirect] Error:', err.message);
    return res.redirect('https://t.me/SCloudMusicBot');
  }
});

  app.get('/', requireAuth, (req, res) => res.redirect('/dashboard'));

// === УПРАВЛЕНИЕ ПРОБЛЕМНЫМИ ТРЕКАМИ ===

// Страница списка с пагинацией
app.get('/broken-tracks', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 25;
    
    const result = await getBrokenTracksWithPagination({ page, limit });
    console.log('[BrokenTracks] Загружено:', result.totalTracks, 'треков');
    
    res.render('broken-tracks', { 
      title: 'Проблемные треки', 
      page: 'broken-tracks',
      tracks: result.tracks || [],
      totalTracks: result.totalTracks || 0,
      totalPages: result.totalPages || 0,
      currentPage: result.currentPage || 1
    });
  } catch (e) {
    console.error('[BrokenTracks] Ошибка загрузки:', e);
    res.status(500).send('Ошибка сервера');
  }
});

// Действие: Исправить (форма)
app.post('/broken-tracks/fix', requireAuth, async (req, res) => {
  const { id, url } = req.body;
  try {
    if (url) await deleteCachedTrack(url);
    await resolveBrokenTrack(id);
    res.redirect('/broken-tracks');
  } catch (e) {
    console.error('[BrokenTracks] Ошибка fix:', e);
    res.status(500).send('Ошибка при исправлении');
  }
});

// API: Пометить исправленным
app.post('/api/broken-tracks/fix', requireAuth, async (req, res) => {
  try {
    const { id, url } = req.body;
    if (url) await deleteCachedTrack(url);
    await resolveBrokenTrack(id);
    res.json({ success: true });
  } catch (e) {
    console.error('[API BrokenTracks] fix error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: Повторить загрузку (сбросить кэш)
app.post('/api/broken-tracks/retry', requireAuth, async (req, res) => {
  try {
    const { id, url } = req.body;
    
    if (!url) {
      return res.status(400).json({ success: false, error: 'URL не указан' });
    }
    
    // Увеличиваем счетчик попыток
    await incrementBrokenTrackRetry(id);
    
    // Удаляем старый кэш
    await deleteCachedTrack(url);
    
    // Помечаем как исправленное
    await resolveBrokenTrack(id);
    
    res.json({ 
      success: true, 
      message: 'Кэш сброшен. Трек будет скачан заново при следующем запросе.' 
    });
  } catch (e) {
    console.error('[API BrokenTracks] retry error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: Удалить одну запись
app.delete('/api/broken-tracks/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await deleteBrokenTrack(parseInt(id));
    res.json({ success: true });
  } catch (e) {
    console.error('[API BrokenTracks] delete error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: Массовое удаление
app.post('/api/broken-tracks/bulk-delete', requireAuth, async (req, res) => {
  try {
    const { ids } = req.body;
    
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: 'Не выбраны записи' });
    }
    
    const count = await deleteBrokenTracksBulk(ids.map(id => parseInt(id)));
    res.json({ success: true, deleted: count });
  } catch (e) {
    console.error('[API BrokenTracks] bulk-delete error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: Удалить ВСЕ записи
app.post('/api/broken-tracks/delete-all', requireAuth, async (req, res) => {
  try {
    const count = await deleteAllBrokenTracks();
    res.json({ success: true, deleted: count });
  } catch (e) {
    console.error('[API BrokenTracks] delete-all error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: Исправить и отправить пользователю
app.post('/api/broken-tracks/fix-and-send', requireAuth, async (req, res) => {
  try {
    const { id, url, userId } = req.body;
    
    if (!url || !userId) {
      return res.status(400).json({ success: false, error: 'URL или userId не указаны' });
    }
    
    // Импортируем функцию скачивания
    const { downloadTrackForUser } = await import('./services/downloadManager.js');
    
    // Скачиваем и отправляем
    await downloadTrackForUser(url, parseInt(userId));
    
    // Помечаем как исправленное
    await resolveBrokenTrack(id);
    
    res.json({ 
      success: true, 
      message: 'Трек скачан и отправлен пользователю!' 
    });
  } catch (e) {
    console.error('[API BrokenTracks] fix-and-send error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});
  app.get('/admin', (req, res) => {
    if (req.session.authenticated) return res.redirect('/dashboard');
    res.render('login', { title: 'Вход', page: 'login', layout: false, error: null });
  });

  const loginAttempts = new Map();
  app.post('/admin', (req, res) => {
    const ip = req.ip;
    const now = Date.now();
    const attempts = loginAttempts.get(ip) || [];
    const recentAttempts = attempts.filter(ts => now - ts < 15 * 60 * 1000);

    if (recentAttempts.length >= 5) {
      return res.render('login', { title: 'Вход', error: 'Слишком много попыток. Попробуйте через 15 минут.', page: 'login', layout: false });
    }

    if (req.body.username === ADMIN_LOGIN && req.body.password === ADMIN_PASSWORD) {
      loginAttempts.delete(ip);
      req.session.authenticated = true;
      req.session.userId = ADMIN_ID;
      res.redirect('/dashboard');
    } else {
      recentAttempts.push(now);
      loginAttempts.set(ip, recentAttempts);
      res.render('login', { title: 'Вход', error: 'Неверные данные', page: 'login', layout: false });
    }
  });

  app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/admin')));
app.post('/admin/queue/clear', requireAuth, (req, res) => {
  const count = downloadQueue.clear();
  console.log(`[Admin] Очередь полностью очищена, удалено ${count} задач.`);
  // Можно добавить flash-сообщение об успехе
  res.redirect('back');
});

// Очистка очереди для конкретного пользователя
app.post('/admin/queue/clear-user', requireAuth, (req, res) => {
  const { userId } = req.body;
  if (userId) {
    const count = downloadQueue.clearUser(userId);
    console.log(`[Admin] Очищена очередь для пользователя ${userId}, удалено ${count} задач.`);
  }
  res.redirect('back');
});

// API: Получение статистики очередей по источникам
app.get('/admin/api/queue/stats', requireAuth, (req, res) => {
  try {
    const stats = downloadQueue.getStatsBySource();
    res.json({
      success: true,
      stats: {
        spotify: stats.spotify,
        youtube: stats.youtube,
        soundcloud: stats.soundcloud,
        other: stats.other,
        total: {
          waiting: stats.spotify.waiting + stats.youtube.waiting + stats.soundcloud.waiting + stats.other.waiting,
          active: stats.spotify.active + stats.youtube.active + stats.soundcloud.active + stats.other.active
        }
      }
    });
  } catch (error) {
    console.error('[Admin API] Ошибка получения статистики очередей:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Очистка очереди по источнику
app.post('/admin/queue/clear/:source', requireAuth, (req, res) => {
  const { source } = req.params;
  const validSources = ['spotify', 'youtube', 'soundcloud', 'other'];
  
  if (!validSources.includes(source)) {
    return res.status(400).json({ success: false, error: 'Неверный источник' });
  }
  
  try {
    const count = downloadQueue.clearBySource(source);
    console.log(`[Admin] Очищена очередь для источника ${source}, удалено ${count} задач.`);
    res.redirect('back');
  } catch (error) {
    console.error(`[Admin] Ошибка очистки очереди для ${source}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});
app.get('/settings', requireAuth, (req, res) => {
  const queueStats = downloadQueue.getStatsBySource();
  res.render('settings', {
    title: 'Настройки',
    page: 'settings',
    settings: getAllSettings(),
    success: req.query.success,
    error: req.query.error,
    maintenanceMode: isMaintenanceMode(),
    queueWaiting: downloadQueue?.size || 0,
    queueActive: downloadQueue?.active || 0,
    queueStats
  });
});

app.post('/settings/maintenance', requireAuth, async (req, res) => {
  const enabled = req.body.enabled === 'on';
  await setMaintenanceMode(enabled);
  console.log(`[Settings] Режим обслуживания: ${enabled ? 'ВКЛЮЧЁН' : 'ВЫКЛЮЧЕН'}`);
  res.redirect('/settings?success=1');
});

app.post('/settings/update', requireAuth, async (req, res) => {
  try {
    console.log('[Settings/Update] Получены данные:', JSON.stringify(sanitizeLogValue(req.body), null, 2));
    
    const workerKeys = ['download_workers_total', 'download_workers_spotify', 'download_workers_soundcloud', 'download_workers_youtube'];
    if (workerKeys.some(key => Object.prototype.hasOwnProperty.call(req.body, key))) {
      const current = getAllSettings();
      const candidate = Object.fromEntries(workerKeys.map(key => [key, req.body[key] ?? current[key]]));
      const total = Number(candidate.download_workers_total);
      const sourceValues = workerKeys.slice(1).map(key => Number(candidate[key]));
      if (!Number.isInteger(total) || total < 1 || sourceValues.some(value => !Number.isInteger(value) || value < 0)) {
        return res.redirect('/settings?error=' + encodeURIComponent('Воркеры должны быть целыми неотрицательными числами, общий лимит — не меньше 1.'));
      }
      if (sourceValues.reduce((sum, value) => sum + value, 0) > total) {
        return res.redirect('/settings?error=' + encodeURIComponent('Сумма воркеров источников не может превышать общий лимит.'));
      }
      const stats = downloadQueue.getStatsBySource();
      const sourceNames = ['spotify', 'soundcloud', 'youtube'];
      const blockedSource = sourceNames.find((source, index) =>
        sourceValues[index] === 0 && stats[source].waiting > 0 && String(req.body[`use_${source}`] ?? current[`use_${source}`]) !== 'false'
      );
      if (blockedSource) {
        return res.redirect('/settings?error=' + encodeURIComponent(`Нельзя оставить очередь ${blockedSource} без воркера: сначала отключите сервис или дождитесь завершения очереди.`));
      }
    }

    // Лимиты являются настройками продукта; пользователей массово не перезаписываем.
    for (const [key, value] of Object.entries(req.body)) {
      console.log(`[Settings/Update] Сохраняю: ${key} = ${formatSettingForLog(key, value)}`);
      await setAppSetting(key, value);
    }
    
    await loadSettings(); // Обновляем кеш
    applyDownloadWorkerSettings(getAllSettings());
    const settingsVersion = await redisService.incr('settings:version');
    await redisService.publish('settings:invalidate', settingsVersion || Date.now());
    console.log('[Settings/Update] ✅ Настройки сохранены и кеш обновлён');

    res.redirect('/settings?success=true');
  } catch (e) {
    console.error('Ошибка сохранения настроек:', e);
    res.status(500).send('Ошибка сохранения настроек');
  }
});

// ==================================================================
// ДАШБОРД
// ==================================================================
app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    let storageStatus = { available: false, error: '' };
    if (STORAGE_CHANNEL_ID) {
      try {
        await bot.telegram.getChat(STORAGE_CHANNEL_ID);
        storageStatus.available = true;
      } catch (e) {
        storageStatus.error = e.message;
      }
    }

    // Получаем даты из запроса (или undefined)
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;
    const promoPeriod = ['today','7d','30d','all'].includes(req.query.promoPeriod) ? req.query.promoPeriod : '30d';
    const showArchivedPromos = req.query.showArchivedPromos === '1';

    const [
      totals,
      cachedTracksCount,
      topSources,
      dailyStats,
      weekdayActivity,
      topTracks,
      topUsers,
      hourlyActivity,
      referralStats,
      tariffsActiveResult,
      othersResult,
      expiredCountResult,
      promoStatsResult
    ] = await Promise.all([
      getUsersTotalsSnapshot(),
      getCachedTracksCount(),
      getTopReferralSources(),
      getDailyStats({ startDate, endDate }),
      
      // 👇 ИСПРАВЛЕНО: Передаем даты в графики
      getActivityByWeekday(startDate, endDate),
      
      getTopTracks(),
      getTopUsers(),
      
      // 👇 ИСПРАВЛЕНО: Передаем даты в графики
      getHourlyActivity(startDate, endDate),
      
      getReferralStats(),
      
      // Активные тарифы
      pool.query(`
        SELECT
          COUNT(*) FILTER (
            WHERE premium_until IS NULL
               OR premium_until < NOW()
               OR (
                 premium_limit IS NOT NULL
                 AND premium_limit <= COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3)
               )
          ) AS free,
          COUNT(*) FILTER (
            WHERE premium_limit = COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_plus'), 30)
              AND premium_until IS NOT NULL AND premium_until >= NOW()
          ) AS plus,
          COUNT(*) FILTER (
            WHERE premium_limit = COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_pro'), 100)
              AND premium_until IS NOT NULL AND premium_until >= NOW()
          ) AS pro,
          COUNT(*) FILTER (
            WHERE (premium_limit = COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_unlim'), 10000) OR premium_limit IS NULL)
              AND premium_until IS NOT NULL AND premium_until >= NOW()
          ) AS unlimited
        FROM users
      `),
      // Другие
      pool.query(`
        SELECT COUNT(*)::int AS other
        FROM users
        WHERE premium_limit NOT IN (
          COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3),
          COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_plus'), 30),
          COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_pro'), 100),
          COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_unlim'), 10000)
        )
        AND premium_limit IS NOT NULL
        AND premium_until IS NOT NULL AND premium_until >= NOW()
      `),
      // Истёкшие
      pool.query(`
        SELECT COUNT(*)::int AS expired_count
        FROM users
        WHERE premium_until IS NOT NULL
          AND premium_until < NOW()
          AND (premium_limit <> COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3) OR premium_limit IS NULL)
      `),
      getDashboardPromoCampaignStats({period:promoPeriod,includeArchived:showArchivedPromos})
    ]);

    const expiredCount = Number(expiredCountResult?.rows?.[0]?.expired_count ?? 0);
    const t = tariffsActiveResult?.rows?.[0] || {};
    const othersCount = Number(othersResult?.rows?.[0]?.other ?? 0);
    const promoStats = promoStatsResult || [];

    const usersByTariff = {
      Free: Number(t.free || 0),
      Plus: Number(t.plus || 0),
      Pro: Number(t.pro || 0),
      Unlimited: Number(t.unlimited || 0),
      Other: othersCount
    };

    // Получаем статистику очередей по источникам
    const queueStatsBySource = downloadQueue.getStatsBySource();

    const stats = {
      total_users: totals.total_users,
      active_users: totals.active_users,
      total_downloads: Number(totals.total_downloads) || 0,
      active_today: totals.active_today,
      queueWaiting: downloadQueue.size,
      queueActive: downloadQueue.pending,
      queueStatsBySource, // Добавляем детализированную статистику по источникам
      cachedTracksCount: cachedTracksCount,
      usersByTariff,
      topSources: topSources || [],
      totalReferred: referralStats.totalReferred,
      topReferrers: referralStats.topReferrers
    };

    // Формируем данные для графика с разделением по сервисам
    const sourceColors = {
      spotify: '#1DB954',    // Зелёный Spotify
      youtube: '#FF0000',    // Красный YouTube
      soundcloud: '#FF5500', // Оранжевый SoundCloud
      other: '#6c757d'       // Серый для других
    };
    
    const sourceLabels = {
      spotify: '🎵 Spotify',
      youtube: '▶️ YouTube',
      soundcloud: '☁️ SoundCloud',
      other: '📦 Другие'
    };
    
    // Собираем данные по сервисам
    const sourceData = {};
    const allSources = ['spotify', 'youtube', 'soundcloud', 'other'];
    
    // Инициализируем массивы для всех источников
    allSources.forEach(source => {
      sourceData[source] = [];
    });
    
    (dailyStats || []).forEach(d => {
      let downloadsBySource = {};
      try {
        if (d.downloads_by_source) {
          downloadsBySource = typeof d.downloads_by_source === 'string' 
            ? JSON.parse(d.downloads_by_source || '{}') 
            : (d.downloads_by_source || {});
        }
      } catch (e) {
        console.error('[Chart] Ошибка парсинга downloads_by_source:', e.message);
        downloadsBySource = {};
      }
      
      // Заполняем данные для каждого источника (0 если нет данных)
      allSources.forEach(source => {
        sourceData[source].push(parseInt(downloadsBySource[source] || 0, 10));
      });
    });
    
    // Создаём датасеты для каждого сервиса
    const sourceDatasets = Object.keys(sourceData).map(source => ({
      label: sourceLabels[source] || source,
      data: sourceData[source],
      borderColor: sourceColors[source] || sourceColors.other,
      backgroundColor: sourceColors[source] || sourceColors.other,
      tension: 0.1,
      fill: false
    }));
    
    const chartDataCombined = {
      labels: (dailyStats || []).map(d => new Date(d.day).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })),
      datasets: [
        { label: '👥 Регистрации', data: (dailyStats || []).map(d => d.registrations), borderColor: '#198754', tension: 0.1, fill: false, borderDash: [5, 5] },
        { label: '👤 Активные юзеры', data: (dailyStats || []).map(d => d.active_users), borderColor: '#0d6efd', tension: 0.1, fill: false, borderDash: [5, 5] },
        ...sourceDatasets // Добавляем линии для каждого сервиса
      ]
    };

    const chartDataTariffs = {
      labels: ['Free', 'Plus', 'Pro', 'Unlimited', 'Other'],
      datasets: [{
        data: [usersByTariff.Free, usersByTariff.Plus, usersByTariff.Pro, usersByTariff.Unlimited, usersByTariff.Other],
        backgroundColor: ['#6c757d', '#17a2b8', '#ffc107', '#007bff', '#dc3545']
      }]
    };

    const chartDataWeekday = {
      labels: (weekdayActivity || []).map(d => (d.weekday || '').toString().trim()),
      datasets: [{
        label: 'Активные пользователи',
        data: (weekdayActivity || []).map(d => d.count),
        backgroundColor: 'rgba(13, 110, 253, 0.5)'
      }]
    };
    
    const chartDataHourly = {
      labels: Array.from({ length: 24 }, (_, i) => `${i.toString().padStart(2, '0')}:00`),
      datasets: [{
        label: 'Активность',
        data: hourlyActivity,
        backgroundColor: 'rgba(255, 99, 132, 0.5)',
        borderColor: 'rgba(255, 99, 132, 1)',
        borderWidth: 1
      }]
    };
    
    res.render('dashboard', {
      title: 'Дашборд',
      page: 'dashboard',
      stats,
      storageStatus,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      resetOthers: req.query.resetOthers || null,
      resetExpired: req.query.resetExpired || null,
      chartDataCombined,
      chartDataTariffs,
      chartDataWeekday,
      chartDataHourly,
      topTracks,
      topUsers,
      expiredCount,
      promoStats,
      promoPeriod,
      showArchivedPromos
    });

  } catch (error) {
    console.error('Ошибка дашборда:', error);
    res.status(500).send('Ошибка сервера');
  }
});

  app.get('/users', requireAuth, async (req, res) => {
    try {
      let { q = '', status = '', page = 1, limit = 25, sort = 'created_at', order = 'desc' } = req.query;
      if (Array.isArray(sort)) sort = sort[0] || 'created_at';
      if (Array.isArray(order)) order = order[0] || 'desc';
      const { users, totalPages, totalUsers } = await getPaginatedUsers({
        searchQuery: q, statusFilter: status, page: parseInt(page), limit: parseInt(limit), sortBy: sort, sortOrder: order
      });
      const queryParams = { q, status, page, limit, sort, order };
      
      // Статистика для карточек
      let activeUsers = 0, premiumUsers = 0, newUsersToday = 0;
      try {
        const [activeUsersRes, premiumUsersRes, newUsersTodayRes] = await Promise.all([
          pool.query('SELECT COUNT(*) FROM users WHERE active = true'),
          pool.query('SELECT COUNT(*) FROM users WHERE premium_until > NOW()'),
          getNewUsersCount(1)
        ]);
        activeUsers = parseInt(activeUsersRes.rows[0]?.count || 0);
        premiumUsers = parseInt(premiumUsersRes.rows[0]?.count || 0);
        newUsersToday = newUsersTodayRes || 0;
      } catch (statsErr) {
        console.error('[Users] Ошибка получения статистики:', statsErr.message);
      }
      
      res.render('users', { 
        title: 'Пользователи', 
        page: 'users', 
        users, 
        totalUsers, 
        totalPages, 
        currentPage: parseInt(page), 
        limit: parseInt(limit), 
        searchQuery: q, 
        statusFilter: status, 
        queryParams,
        activeUsers,
        premiumUsers,
        newUsersToday
      });
    } catch (error) {
      console.error('Ошибка на странице пользователей:', error);
      res.status(500).send('Ошибка сервера');
    }
  });

  app.get('/users/export.csv', requireAuth, async (req, res) => {
  try {
    const {
      q = '',
        status = '',
        tariff = '',
        premium = '',
        created_from = '',
        created_to = '',
        active_within_days = '',
        has_referrer = '',
        ref_source = '',
        downloads_min = ''
    } = req.query;
    
    const csvData = await getUsersAsCsv({
      searchQuery: q,
      statusFilter: status,
      tariff,
      premium,
      created_from,
      created_to,
      active_within_days,
      has_referrer,
      ref_source,
      downloads_min
    });
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="users_${new Date().toISOString().slice(0, 10)}.csv"`
    );
    res.send(csvData);
  } catch (error) {
    console.error('Ошибка при экспорте пользователей:', error);
    res.status(500).send('Не удалось сгенерировать CSV-файл');
  }
});
    app.get('/users-table', requireAuth, async (req, res) => {
      // Если это прямой запрос в браузере (например, рефреш), редиректим на красивый роут /users
      if (!req.headers['hx-request']) {
        return res.redirect('/users?' + new URLSearchParams(req.query).toString());
      }

      try {
        let { q = '', status = '', page = 1, limit = 25, sort = 'created_at', order = 'desc' } = req.query;
        if (Array.isArray(sort)) sort = sort[0] || 'created_at';
        if (Array.isArray(order)) order = order[0] || 'desc';
        
        // Устанавливаем заголовок HTMX, чтобы браузер пушил /users вместо /users-table в историю
        res.setHeader('HX-Push-Url', '/users?' + new URLSearchParams(req.query).toString());
        
        // ✅ ДОБАВЛЕНО totalUsers сюда
        const { users, totalPages, totalUsers } = await getPaginatedUsers({
          searchQuery: q, statusFilter: status, page: parseInt(page), limit: parseInt(limit), sortBy: sort, sortOrder: order
        });
      
      const queryParams = { q, status, page, limit, sort, order };
      res.render('partials/users-table', { users, totalPages, totalUsers, currentPage: parseInt(page), queryParams, layout: false });
    } catch (error) {
      console.error('Ошибка при обновлении таблицы:', error);
      res.status(500).send('Ошибка сервера');
    }
  });

app.get('/user/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.params.id;
        const { getLanguageHistoryForUser } = await import('./db.js');
        
        // Теперь мы запрашиваем данные параллельно, включая реферера и историю языка
        const [
            userProfile,
            downloads,
            actions,
            referrer,
            referredUsers,
            languageHistory
        ] = await Promise.all([
            getUserById(userId),
            getDownloadsByUserId(userId),
            getUserActions(userId),
            getReferrerInfo(userId),
            getReferredUsers(userId),
            getLanguageHistoryForUser(userId)
        ]);
        
        if (!userProfile) {
            return res.status(404).send("Пользователь не найден");
        }
        
        // Передаем все данные в шаблон для отрисовки
        const tariffLimits = { free:Number(getSetting('daily_limit_free'))||3, plus:Number(getSetting('daily_limit_plus'))||30, pro:Number(getSetting('daily_limit_pro'))||100, unlimited:Number(getSetting('daily_limit_unlimited')||getSetting('daily_limit_unlim'))||10000 };
        const tariffPresentation = buildUserTariffPresentation(userProfile, tariffLimits);
        res.render('user-profile', {
            title: `Профиль: ${userProfile.first_name || userId}`,
            page: 'users',
            userProfile,
            tariffLimits,
            tariffPresentation,
            downloads,
            actions,
            referrer,
            referredUsers,
            languageHistory: languageHistory || []
        });
        
    } catch (error) {
        console.error(`Ошибка при получении профиля пользователя ${req.params.id}:`, error);
        res.status(500).send("Ошибка сервера");
    }
});

app.post('/user/:id/set-language', requireAuth, async (req, res) => {
    try {
        const userId = req.params.id;
        const { lang } = req.body;
        if (!['ru', 'en'].includes(lang)) {
            return res.status(400).send("Неподдерживаемый язык");
        }

        const { setUserLanguageByAdmin } = await import('./db.js');
        // В сессии isAdmin = true, используем ID админа 0 (или ID из сессии, если есть)
        const adminId = req.session.userId || 0; 
        
        await setUserLanguageByAdmin(userId, lang, adminId);
        res.redirect(`/user/${userId}?success=lang_changed`);
    } catch (error) {
        console.error(`Ошибка смены языка для пользователя ${req.params.id}:`, error);
        res.status(500).send("Ошибка сервера: " + error.message);
    }
});

  app.get('/broadcasts', requireAuth, async (req, res) => {
    const [tasks, broadcastsEnabled] = await Promise.all([
      getAllBroadcastTasks(),
      areBroadcastsEnabled()
    ]);
    res.render('broadcasts', {
      title: 'Управление рассылками',
      page: 'broadcasts',
      tasks,
      broadcastsEnabled
    });
  });

    app.get('/broadcast/new', requireAuth, async (req, res) => {
    let taskData = {
      campaign_name: '',
      campaign_tag: '',
      broadcast_type: 'marketing',
      target_audience: 'all',
      target_languages: ['all'],
      unknown_language_policy: 'use_ru',
      fallback_language: 'ru',
      message_ru: '',
      message_en: '',
      buttons_ru: '',
      buttons_en: ''
    };

    if (req.query.clone) {
      try {
        const clonedTask = await getBroadcastTaskById(req.query.clone);
        if (clonedTask) {
          taskData = mapBroadcastTaskToForm(clonedTask, { clone: true });
        }
      } catch (e) {
        console.error('[Broadcast Clone] Error loading task to clone:', e.message);
      }
    }

    res.render('broadcast-form', {
      title: 'Новая рассылка',
      page: 'broadcasts',
      error: null,
      success: null,
      task: taskData
    });
  });

  // Диагностический эндпоинт для просмотра состояния приложения
  app.get('/debug/state', requireAuth, async (req, res) => {
    const state = getAppState(); // Импортируй из appState.js
    res.json({
      ...state,
      queueSize: downloadQueue.size,
      queuePending: downloadQueue.pending,
      uptime: process.uptime()
    });
  });

    app.get('/broadcast/edit/:id', requireAuth, async (req, res) => {
    const task = await getBroadcastTaskById(req.params.id);
    if (!task || task.status !== 'pending') {
      return res.redirect('/broadcasts');
    }
    const taskData = mapBroadcastTaskToForm(task);
    res.render('broadcast-form', { title: 'Редактировать рассылку', page: 'broadcasts', task: taskData, error: null, success: null });
  });

  app.post('/broadcast/estimate', requireAuth, async (req, res) => {
    try {
      const { targetAudience, targetLanguages, unknownLanguagePolicy, fallbackLanguage, message_ru, message_en } = req.body;
      const messagesJson = {
        ru: message_ru ? { message: message_ru } : null,
        en: message_en ? { message: message_en } : null
      };
      const { estimateBroadcastAudience } = await import('./db.js');
      const stats = await estimateBroadcastAudience(
        targetAudience,
        targetLanguages || ['all'],
        unknownLanguagePolicy,
        'all',
        messagesJson,
        fallbackLanguage || 'ru'
      );
      res.json(stats);
    } catch (e) {
      console.error('[Broadcast Estimate] Error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/broadcast/delete', requireAuth, async (req, res) => {
    const { taskId } = req.body;
    await deleteBroadcastTask(taskId);
    res.redirect('/broadcasts');
  });

  app.post('/broadcasts/toggle', requireAuth, async (req, res) => {
    const enabled = req.body.enabled === 'true';
    await setBroadcastsEnabled(enabled);
    console.warn(`[Broadcast Safety] Global kill switch changed by admin ${req.session.userId}: enabled=${enabled}`);
    res.redirect('/broadcasts');
  });

  app.post('/broadcast/:id/cancel', requireAuth, async (req, res) => {
    const cancelled = await cancelBroadcastTask(req.params.id);
    if (!cancelled) {
      return res.status(409).json({ ok: false, error: 'Campaign is not pending or processing.' });
    }
    console.warn(`[Broadcast Safety] Campaign #${cancelled.id} cancelled by admin ${req.session.userId}; pending recipients cancelled=${cancelled.cancelledRecipients}`);
    res.redirect('/broadcasts');
  });

  app.post('/broadcast/launch-token', requireAuth, async (req, res) => {
    const token = issueBroadcastLaunchToken(req.session);
    await new Promise((resolve, reject) => {
      req.session.save(error => error ? reject(error) : resolve());
    });
    res.json({ ok: true, launchToken: token, expiresInSeconds: 300 });
  });

  app.post('/broadcast/preview', requireAuth, upload.single('file'), async (req, res) => {
    const file = req.file;
    try {
      delete req.session.broadcastLaunchToken;
      await new Promise((resolve, reject) => {
        req.session.save(error => error ? reject(error) : resolve());
      });
      const language = req.body.preview_language;
      const message = language === 'en' ? req.body.message_en : req.body.message_ru;
      const buttons = language === 'en' ? req.body.buttons_en : req.body.buttons_ru;
      const fileId = file ? { source: file.path } : (req.body.existing_file_id || null);
      const fileMimeType = file
        ? (file.mimetype || mime.lookup(file.originalname) || '')
        : (req.body.existing_file_mime_type || null);

      const result = await sendBroadcastPreview({
        bot,
        adminId: req.session.userId,
        language,
        message,
        keyboard: parseButtons(buttons),
        fileId,
        fileMimeType,
        disableNotification: Boolean(req.body.disable_notification),
        disableWebPagePreview: !req.body.enable_web_page_preview,
        sendBatch: runBroadcastBatch
      });
      console.log(`[Broadcast Preview] admin=${req.session.userId} language=${language} recipients=1`);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    } finally {
      if (file) await fs.promises.unlink(file.path).catch(() => {});
    }
  });

  app.get('/broadcast/:id/stats', requireAuth, async (req, res) => {
    try {
      const broadcastId = req.params.id;
      const task = await getBroadcastTaskById(broadcastId);
      if (!task) {
        return res.status(404).send('Рассылка не найдена');
      }

      const { getBroadcastTaskStats } = await import('./db.js');
      const stats = await getBroadcastTaskStats(broadcastId);

      // Мапим кнопки для отображения
      const ruButtons = task.messages_json?.ru?.keyboard?.flat() || [];
      const enButtons = task.messages_json?.en?.keyboard?.flat() || [];
      const buttonLabels = {};
      for (let i = 0; i < Math.max(ruButtons.length, enButtons.length); i++) {
        const ruLabel = ruButtons[i]?.text || '';
        const enLabel = enButtons[i]?.text || '';
        buttonLabels[i] = ruLabel && enLabel && ruLabel !== enLabel ? `${ruLabel} / ${enLabel}` : (ruLabel || enLabel || `Кнопка #${i + 1}`);
      }

      res.render('broadcast-stats', {
        title: `Статистика рассылки #${broadcastId}`,
        page: 'broadcasts',
        task,
        stats,
        buttonLabels
      });
    } catch (e) {
      console.error('[Broadcast Stats] Error:', e.message);
      res.status(500).send('Ошибка загрузки статистики: ' + e.message);
    }
  });


  app.post('/tariffs/reset-expired', requireAuth, async (req, res) => {
    try {
      const n = await resetExpiredPremiumsBulk();
      res.redirect('/dashboard?resetExpired=' + n);
    } catch (e) {
      console.error('[Tariffs] reset-expired error:', e.message);
      res.redirect('/dashboard?resetExpired=err');
    }
  });

  app.post(['/broadcast/new', '/broadcast/edit/:id'], requireAuth, upload.single('file'), async (req, res) => {
    if (req.file) await fs.promises.unlink(req.file.path).catch(() => {});
    res.status(400).json({
      ok: false,
      error: 'Legacy broadcast mutation endpoint is disabled. Use POST /broadcast/launch with action=launch.'
    });
  });

  app.post('/broadcast/launch', requireAuth, upload.single('file'), async (req, res) => {
    const isEditing = Boolean(req.body.edit_task_id);
    const taskId = req.body.edit_task_id || null;
    const file = req.file;

    try {
      const {
        campaign_name,
        campaign_tag,
        broadcast_type,
        targetAudience,
        unknown_language_policy,
        fallback_language,
        message_ru,
        buttons_ru,
        message_en,
        buttons_en,
        scheduledAt,
        disable_notification,
        enable_web_page_preview,
        existing_file_id,
        existing_file_mime_type,
        launch_token,
        action
      } = req.body;

      validateBroadcastLaunchRequest(req.session, { action, launch_token });
      await new Promise((resolve, reject) => {
        req.session.save(error => error ? reject(error) : resolve());
      });
      if (!(await areBroadcastsEnabled())) {
        throw new Error('Broadcast launch is blocked by the global kill switch.');
      }

      let targetLanguages = req.body['target_languages[]'] || ['all'];
      if (!Array.isArray(targetLanguages)) {
        targetLanguages = [targetLanguages];
      }

      // Подготавливаем task для рендера в случае ошибки или превью
      const taskForRender = {
        campaign_name,
        campaign_tag,
        broadcast_type,
        target_audience: targetAudience,
        target_languages: targetLanguages,
        unknown_language_policy,
        fallback_language,
        message_ru,
        buttons_ru,
        message_en,
        buttons_en,
        file_id: existing_file_id || null,
        file_mime_type: existing_file_mime_type || null,
        disable_notification: !!disable_notification,
        disable_web_page_preview: !enable_web_page_preview
      };
      if (isEditing) taskForRender.id = taskId;

      const renderOptions = {
        title: isEditing ? 'Редактировать рассылку' : 'Новая рассылка',
        page: 'broadcasts',
        success: null,
        error: null,
        task: taskForRender
      };

      const existingTask = isEditing
        ? await getBroadcastTaskById(taskId)
        : {
            file_id: existing_file_id || null,
            file_mime_type: existing_file_mime_type || null
          };

      // Валидация наличия контента
      const hasAnyMessage = message_ru || message_en;
      if (!hasAnyMessage && !file && !(existingTask && existingTask.file_id)) {
        if (file) await fs.promises.unlink(file.path).catch(() => {});
        renderOptions.error = 'Сообщение не может быть пустым, если не прикреплен файл.';
        return res.render('broadcast-form', renderOptions);
      }

      let fileId = existingTask.file_id || null;
      let fileMimeType = existingTask.file_mime_type || null;

      if (file) {
        if (!BROADCAST_STORAGE_ID) {
          await fs.promises.unlink(file.path).catch(() => {});
          renderOptions.error = 'Технический канал-хранилище (BROADCAST_STORAGE_ID) не настроен!';
          return res.render('broadcast-form', renderOptions);
        }
        console.log('[Broadcast] Загружен новый файл, отправляю в хранилище...');
        const mimeType = file.mimetype || mime.lookup(file.originalname) || '';
        let sentMessage;
        const source = { source: file.path };

        if (mimeType.startsWith('image/')) sentMessage = await bot.telegram.sendPhoto(BROADCAST_STORAGE_ID, source);
        else if (mimeType.startsWith('video/')) sentMessage = await bot.telegram.sendVideo(BROADCAST_STORAGE_ID, source);
        else if (mimeType.startsWith('audio/')) sentMessage = await bot.telegram.sendAudio(BROADCAST_STORAGE_ID, source);
        else sentMessage = await bot.telegram.sendDocument(BROADCAST_STORAGE_ID, source);

        fileId = sentMessage.photo?.pop()?.file_id || sentMessage.video?.file_id || sentMessage.audio?.file_id || sentMessage.document?.file_id;
        fileMimeType = mimeType;

        await fs.promises.unlink(file.path).catch(() => {});
      }

      // Сохранение задачи в базу
      const messagesJson = {
        ru: message_ru ? { message: message_ru, keyboard: parseButtons(buttons_ru) } : null,
        en: message_en ? { message: message_en, keyboard: parseButtons(buttons_en) } : null
      };

      const taskData = {
        campaign_name,
        campaign_tag,
        broadcast_type,
        messages_json: messagesJson,
        target_languages: targetLanguages,
        unknown_language_policy,
        fallback_language,
        message: message_ru || message_en || '',
        keyboard: parseButtons(buttons_ru) || parseButtons(buttons_en) || null,
        file_id: fileId,
        file_mime_type: fileMimeType,
        targetAudience,
        disableNotification: !!disable_notification,
        disable_web_page_preview: !enable_web_page_preview,
        launch_confirmed_at: new Date(),
        launch_confirmed_by: req.session.userId
      };

      const scheduleTime = scheduledAt ? new Date(scheduledAt) : new Date();
      let persistedTask;
      if (isEditing) {
        persistedTask = await updateBroadcastTask(taskId, { ...taskData, scheduledAt: scheduleTime });
      } else {
        persistedTask = await createBroadcastTask({ ...taskData, scheduledAt: scheduleTime });
      }
      if (!persistedTask) throw new Error('Campaign is no longer editable or could not be created.');
      console.warn(`[Broadcast Launch] Campaign #${persistedTask?.id} confirmed by admin ${req.session.userId}.`);
      res.redirect('/broadcasts');

    } catch (e) {
      console.error(`Ошибка создания/редактирования задачи (ID: ${taskId}):`, e);
      if (file) {
        try { await fs.promises.unlink(file.path); } catch (_) {}
      }

      const renderOptionsError = {
        title: isEditing ? 'Редактировать рассылку' : 'Новая рассылка',
        page: 'broadcasts',
        error: 'Не удалось сохранить задачу. ' + e.message,
        success: null,
        task: {
          ...req.body,
          target_audience: req.body.targetAudience,
          target_languages: req.body['target_languages[]'] || ['all'],
          message_ru: req.body.message_ru,
          message_en: req.body.message_en,
          buttons_ru: req.body.buttons_ru,
          buttons_en: req.body.buttons_en,
          file_id: req.body.existing_file_id || null,
          file_mime_type: req.body.existing_file_mime_type || null
        }
      };
      if (isEditing) renderOptionsError.task.id = taskId;

      res.status(400).render('broadcast-form', renderOptionsError);
    }
  });


  app.get('/texts', requireAuth, async (req, res) => {
    try {
      const texts = getEditableTexts();
      res.render('texts', {
        title: 'Редактор текстов',
        page: 'texts',
        texts,
        success: req.query.success
      });
    } catch (error) {
      console.error('Ошибка на странице текстов:', error);
      res.status(500).send('Ошибка сервера');
    }
  });

  app.post('/texts/update', requireAuth, async (req, res) => {
  try {
    const { key, value } = req.body;
    
    // Простая валидация: ключ и значение не должны быть пустыми
    if (!key || !value.trim()) {
      throw new Error('Ключ или значение не могут быть пустыми.');
    }
    
    await setText(key, value);
    
    // Перенаправляем с хешем, чтобы аккордеон остался открытым
    res.redirect(`/texts?success=true#collapse-${encodeURIComponent(key)}`);
    
  } catch (error) {
    console.error('Ошибка при обновлении текста:', error);
    
    // Перенаправляем на ту же страницу, но с сообщением об ошибке
    res.redirect(`/texts?error=${encodeURIComponent(error.message)}`);
  }
});

  // --- УПРАВЛЕНИЕ РЕКЛАМНЫМИ КАМПАНИЯМИ (PROMO CAMPAIGNS) ---

  app.get('/promos', requireAuth, async (req, res) => {
    try {
      const campaigns = await getPromoCampaigns();
      const [stats,creativeStats,triggerStats] = await Promise.all([getPromoStats(),getPromoCreativeStats(),getPromoTriggerStats()]);
      const editableTexts = getEditableTexts();
      
      const preparedCampaigns = campaigns.map(c => {
        if (c.id === 1) {
          return {
            ...c,
            message_text: editableTexts.yandex_promo_message || '',
            button_text: editableTexts.yandex_promo_button || '💰 Забрать 300₽ на телефон',
            url: editableTexts.yandex_promo_url || ''
          };
        } else if (c.id === 2) {
          return {
            ...c,
            message_text: editableTexts.yandex_music_promo_message || '',
            button_text: editableTexts.yandex_music_promo_button || '🎵 Попробовать Яндекс Музыку',
            url: editableTexts.yandex_music_promo_url || ''
          };
        }
        return c;
      });

      res.render('promo-campaigns', {
        title: 'Управление рекламой',
        page: 'promos',
        campaigns: preparedCampaigns,
        stats,
        creativeStats,
        triggerStats,
        success: req.query.success,
        error: req.query.error
      });
    } catch (e) {
      console.error('[Admin Promos] Error:', e);
      res.status(500).send('Ошибка сервера');
    }
  });

  app.post('/promos/save', requireAuth, handlePromoMediaUpload, async (req, res) => {
    const { id, name, promo_key, trigger_downloads, trigger_type='download_count', trigger_download_count, global_category_cooldown_days='7', cooldown_after_click_days='30', message_text, button_text, url, category='custom', weight='1', cooldown_days='7', max_impressions_per_user='3', starts_at, ends_at } = req.body;
    let uploadedMedia = null;
    let previousCampaign = null;
    let campaignSaved = false;
    try {
      if (!name || !message_text || !url) {
        throw new Error('Название, текст сообщения и ссылка не могут быть пустыми.');
      }
      
      const campaignId = parseInt(id, 10);
      const normalizedPromoKey = normalizePromoKey(promo_key, name);
      if (!PROMO_CATEGORIES.has(category)) throw new Error('Некорректная категория кампании.');
      if (trigger_type === 'manual') throw new Error('Ручной запуск кампаний пока недоступен: API отправки ещё не реализован.');
      if (!['download_count','activity_cooldown','combined'].includes(trigger_type)) throw new Error('Некорректный тип запуска кампании.');
      
      // Вытягиваем текущий статус активности, чтобы не сбрасывать его при сохранении настроек
      let currentIsActive = true;
      if (campaignId) {
        previousCampaign = await getPromoCampaignById(campaignId);
        if (previousCampaign) {
          currentIsActive = previousCampaign.is_active;
        }
      }
      if (req.file) {
        if (!supabase) throw new Error('Supabase Storage не настроен. Медиа не сохранено.');
        uploadedMedia = await uploadAdCampaignMedia({storage:supabase.storage.from(AD_CAMPAIGN_MEDIA_BUCKET),buffer:req.file.buffer,originalName:req.file.originalname});
      }
      const removeMedia = req.body.remove_media === '1';
      const mediaFields = uploadedMedia || (removeMedia ? {media_type:null,media_storage_path:null,media_mime_type:null,media_file_size:null,media_file_name:null} : {
        media_type:previousCampaign?.media_type||null,media_storage_path:previousCampaign?.media_storage_path||null,media_mime_type:previousCampaign?.media_mime_type||null,media_file_size:previousCampaign?.media_file_size||null,media_file_name:previousCampaign?.media_file_name||null
      });
      const triggerCount=Math.max(1,parseInt(trigger_download_count||trigger_downloads,10)||1);
      const common = { name, trigger_downloads:triggerCount, trigger_type, trigger_download_count:triggerCount, global_category_cooldown_days:Math.max(0,parseInt(global_category_cooldown_days,10)||0), cooldown_after_click_days:Math.max(0,parseInt(cooldown_after_click_days,10)||0), activity_cooldown:['activity_cooldown','combined'].includes(trigger_type), message_text, button_text:button_text||'Открыть', url, is_active:currentIsActive, category, weight:Math.max(0,parseInt(weight,10)||0), cooldown_days:Math.max(0,parseInt(cooldown_days,10)||0), max_impressions_per_user:Math.max(1,parseInt(max_impressions_per_user,10)||3), starts_at:starts_at||null, ends_at:ends_at||null, ...mediaFields };
      
      let savedCampaign;
      if (campaignId === 1) {
        await setText('yandex_promo_message', message_text);
        await setText('yandex_promo_button', button_text || '💰 Забрать 300₽ на телефон');
        await setText('yandex_promo_url', url);
        savedCampaign = await updatePromoCampaign(1, {
          ...common,
          message_text: '',
          button_text: '',
          url: ''
        });
      } else if (campaignId === 2) {
        await setText('yandex_music_promo_message', message_text);
        await setText('yandex_music_promo_button', button_text || '🎵 Попробовать Яндекс Музыку');
        await setText('yandex_music_promo_url', url);
        savedCampaign = await updatePromoCampaign(2, {
          ...common,
          message_text: '',
          button_text: '',
          url: ''
        });
      } else if (campaignId) {
        savedCampaign = await updatePromoCampaign(campaignId, common);
      } else {
        savedCampaign = await createPromoCampaign({
          ...common, promo_key:normalizedPromoKey, is_active:true
        });
      }
      campaignSaved = true;
      await writeAdCampaignAudit({campaignId:savedCampaign.id,promoKey:savedCampaign.promo_key,action:previousCampaign?'campaign_updated':'campaign_created',adminId:req.session.userId,oldValues:previousCampaign,newValues:savedCampaign});
      if (previousCampaign && previousCampaign.media_storage_path !== savedCampaign.media_storage_path) await writeAdCampaignAudit({campaignId:savedCampaign.id,promoKey:savedCampaign.promo_key,action:'campaign_media_replaced',adminId:req.session.userId,oldValues:{media_storage_path:previousCampaign.media_storage_path},newValues:{media_storage_path:savedCampaign.media_storage_path}});
      if (previousCampaign?.media_storage_path && previousCampaign.media_storage_path !== mediaFields.media_storage_path) {
        await removeAdCampaignMediaSafely({storage:supabase.storage.from(AD_CAMPAIGN_MEDIA_BUCKET),storagePath:previousCampaign.media_storage_path,isInUse:path=>isPromoMediaPathInUse(path,campaignId)}).catch(error=>console.error('[Admin Promos Media Cleanup]',error.message));
      }
      
      res.redirect('/promos?success=true');
    } catch (e) {
      if (!campaignSaved && uploadedMedia?.media_storage_path && supabase) await supabase.storage.from(AD_CAMPAIGN_MEDIA_BUCKET).remove([uploadedMedia.media_storage_path]).catch(()=>{});
      console.error('[Admin Promos Save] Error:', e);
      res.redirect(`/promos?error=${encodeURIComponent(e.message)}`);
    }
  });

  app.post('/promos/reset', requireAuth, async (req, res) => {
    const { id } = req.body;
    try {
      const campaignId = parseInt(id, 10);
      await resetPromoCampaign(campaignId);
      res.redirect('/promos?success=true');
    } catch (e) {
      console.error('[Admin Promos Reset] Error:', e);
      res.redirect(`/promos?error=${encodeURIComponent(e.message)}`);
    }
  });

  app.get('/promos/media/:id', requireAuth, async (req,res) => {
    try {
      const campaign = await getPromoCampaignById(Number(req.params.id));
      if (!campaign?.media_storage_path || !supabase) return res.status(404).send('Медиа не найдено.');
      const signedUrl = await createAdCampaignMediaSignedUrl({storage:supabase.storage.from(AD_CAMPAIGN_MEDIA_BUCKET),storagePath:campaign.media_storage_path,expiresIn:60});
      res.setHeader('Cache-Control','private, no-store');
      res.redirect(302,signedUrl);
    } catch (error) {
      console.error('[Admin Promos Media Preview]',error.message);
      res.status(404).send('Медиа недоступно.');
    }
  });

  app.post('/promos/toggle', requireAuth, async (req, res) => {
    const { id, is_active } = req.body;
    try {
      const campaignId = parseInt(id, 10);
      const active = is_active === 'true' || is_active === true || is_active === '1';
      const campaigns = await getPromoCampaigns();
      const current = campaigns.find(c => c.id === campaignId);
      
      if (!current) {
        throw new Error('Кампания не найдена');
      }
      
      await updatePromoCampaign(campaignId, {
        ...current,
        is_active: active
      });
      const updated = await getPromoCampaignById(campaignId);
      await writeAdCampaignAudit({campaignId,promoKey:current.promo_key,action:active?'campaign_enabled':'campaign_disabled',adminId:req.session.userId,oldValues:current,newValues:updated});
      
      res.json({ success: true });
    } catch (e) {
      console.error('[Admin Promos Toggle] Error:', e);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/admin/api/ad-campaigns/:id/archive',requireAuth,async(req,res)=>{
    try { const campaign=await archivePromoCampaign(Number(req.params.id),req.session.userId); res.json({success:true,campaign}); }
    catch(error){res.status(400).json({success:false,error:error.message});}
  });

  app.post('/admin/api/ad-campaigns/:id/restore',requireAuth,async(req,res)=>{
    try { const campaign=await restorePromoCampaign(Number(req.params.id),req.session.userId); res.json({success:true,campaign}); }
    catch(error){res.status(400).json({success:false,error:error.message});}
  });

  app.post('/admin/api/ad-campaigns/:id/reset',requireAuth,async(req,res)=>{
    try { const campaign=await resetSystemPromoCampaign(Number(req.params.id),req.session.userId); res.json({success:true,campaign}); }
    catch(error){res.status(400).json({success:false,error:error.message});}
  });

  app.delete('/admin/api/ad-campaigns/:id',requireAuth,async(req,res)=>{
    const campaignId=Number(req.params.id);
    let removedMedia=null;
    try {
      if(!Number.isSafeInteger(campaignId)||campaignId<=0) throw new Error('Некорректный идентификатор кампании');
      const campaign=await getPromoCampaignById(campaignId);
      if(!campaign) throw new Error('Кампания не найдена');
      if(campaign.is_system) throw new Error('Системную кампанию удалить нельзя. Её можно отключить.');
      if(!campaign.is_archived) throw new Error('Удаление доступно только из архива');
      if(String(req.body?.confirm_name||'')!==campaign.name) throw new Error('Для удаления введите точное название кампании');
      if(campaign.media_storage_path&&!supabase) throw new Error('Supabase Storage недоступен. Кампания не удалена.');
      if(campaign.media_storage_path&&supabase&&!await isPromoMediaPathInUse(campaign.media_storage_path,campaignId)){
        const bucket=supabase.storage.from(AD_CAMPAIGN_MEDIA_BUCKET);
        const {data,error}=await bucket.download(campaign.media_storage_path);if(error||!data)throw new Error(`Не удалось подготовить удаление медиа: ${error?.message||'empty file'}`);
        removedMedia={path:campaign.media_storage_path,buffer:Buffer.from(await data.arrayBuffer()),mime:campaign.media_mime_type};
        const removal=await bucket.remove([campaign.media_storage_path]);if(removal.error)throw new Error(`Не удалось удалить медиа: ${removal.error.message}`);
      }
      try { await softDeletePromoCampaign(campaignId,req.session.userId); }
      catch(dbError){
        if(removedMedia&&supabase){const restored=await supabase.storage.from(AD_CAMPAIGN_MEDIA_BUCKET).upload(removedMedia.path,removedMedia.buffer,{contentType:removedMedia.mime,upsert:false});if(restored.error)console.error('[Admin Promos Delete Rollback]',restored.error.message);}
        throw dbError;
      }
      res.json({success:true});
    } catch(error){res.status(400).json({success:false,error:error.message});}
  });

  app.post('/promos/delete', requireAuth, async (req, res) => {
    res.redirect('/promos?error='+encodeURIComponent('Сначала архивируйте кампанию, затем удалите её из раздела «Архивные».'));
  });

  app.get('/expiring-users', requireAuth, async (req, res) => {
    try {
      const users = await getExpiringUsers();
      
      // Считаем статистику (непересекающиеся группы)
      const now = new Date();
      let expiringToday = 0, expiring2to3Days = 0, expiring4to7Days = 0;
      
      users.forEach(u => {
        if (!u.premium_until) return;
        const days = Math.ceil((new Date(u.premium_until) - now) / (1000 * 60 * 60 * 24));
        if (days <= 1) expiringToday++;
        else if (days <= 3) expiring2to3Days++;
        else if (days <= 7) expiring4to7Days++;
      });
      
      const totalExpiring = expiringToday + expiring2to3Days + expiring4to7Days;
      
      res.render('expiring-users', { 
        title: 'Истекающие подписки', 
        page: 'expiring-users', 
        users,
        expiringToday,
        expiring2to3Days,
        expiring4to7Days,
        totalExpiring
      });
    } catch (e) {
      console.error('[Expiring Users] Error:', e);
      res.status(500).send('Ошибка сервера');
    }
  });

  // --- Роуты службы техподдержки ---

  app.get('/support', requireAuth, async (req, res) => {
    try {
      const tickets = await getSupportTickets();
      res.render('support', { 
        title: 'Техподдержка', 
        page: 'support', 
        tickets, 
        activeUserId: null, 
        messages: [],
        settings: getAllSettings()
      });
    } catch (e) {
      console.error('[Support] Error:', e);
      res.status(500).send('Ошибка сервера');
    }
  });

  app.get('/support/:userId', requireAuth, async (req, res) => {
    const { userId } = req.params;
    try {
      const tickets = await getSupportTickets();
      const messages = await getSupportMessages(userId);
      await markSupportMessagesAsRead(userId);
      res.render('support', { 
        title: `Чат с пользователем ID ${userId}`, 
        page: 'support', 
        tickets, 
        activeUserId: userId, 
        messages,
        settings: getAllSettings()
      });
    } catch (e) {
      console.error('[Support Details] Error:', e);
      res.status(500).send('Ошибка сервера');
    }
  });

  app.get('/support/:userId/json', requireAuth, async (req, res) => {
    const { userId } = req.params;
    try {
      const messages = await getSupportMessages(userId);
      await markSupportMessagesAsRead(userId);
      res.json({ success: true, messages });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/support/file/:messageId', requireAuth, async (req, res) => {
    try {
      const message = await getSupportMessageById(req.params.messageId);
      if (!message || message.media_type !== 'photo') return res.status(404).send('Вложение не найдено.');
      const resolved = await resolveSupportImage({ message, storage: supabase.storage.from('support-attachments'), telegram: bot.telegram });
      res.setHeader('Cache-Control', 'private, no-store');
      res.redirect(302, resolved.url);
    } catch (e) {
      console.error('[Support File Proxy] Error:', e.message);
      res.status(404).send('File not found');
    }
  });

app.post('/support/:userId/send', requireAuth, upload.single('image'), async (req, res) => {
    const { userId } = req.params;
    const { message } = req.body;
    
    if ((!message || !message.trim()) && !req.file) {
      return res.status(400).send('Сообщение не может быть пустым');
    }

    try {
      // 1. Отправляем в Telegram
      let fileId = null;
      if (req.file) {
        validateSupportImage({ mimeType: req.file.mimetype, size: req.file.size });
        try {
          const sent = await bot.telegram.sendPhoto(userId, { source: req.file.path }, { caption: message?.trim() || undefined });
          fileId = sent.photo?.at(-1)?.file_id || null;
        } catch (imageError) {
          if (!message?.trim()) throw imageError;
          await bot.telegram.sendMessage(userId, `✉️ <b>Ответ от поддержки:</b>\n\n${message}`, { parse_mode: 'HTML' });
          await createSupportMessage(userId, message, 'admin');
          console.error('[Support Send] Image failed; text delivered:', imageError.message);
          return res.redirect(`/support/${userId}?image_error=1`);
        }
      } else {
        await bot.telegram.sendMessage(userId, `✉️ <b>Ответ от поддержки:</b>\n\n${message}`, { parse_mode: 'HTML' });
      }
      
      // 2. Сохраняем в БД
      await createSupportMessage(userId, message || '', 'admin', fileId ? 'photo' : 'text', fileId);
      
      res.redirect(`/support/${userId}`);
    } catch (e) {
      console.error('[Support Send] Error:', e);
      res.status(500).send('Ошибка при отправке сообщения: ' + e.message);
    } finally {
      if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
    }
  });

  app.post('/support/:userId/close', requireAuth, async (req, res) => {
    const { userId } = req.params;
    try {
      // 1. Удаляем сообщения из БД
      await deleteSupportMessages(userId);
      // 2. Отключаем режим поддержки
      await updateUserField(userId, 'support_mode', false);
      // 3. Уведомляем пользователя
      await bot.telegram.sendMessage(userId, `✅ <b>Ваше обращение в поддержку закрыто.</b>\n\nЕсли у вас возникнут новые вопросы, вы можете начать новый диалог с помощью команды /support или кнопки в разделе помощи.`, { parse_mode: 'HTML' }).catch(() => {});
      
      res.redirect('/support');
    } catch (e) {
      console.error('[Support Close] Error:', e);
      res.status(500).send('Ошибка при закрытии обращения: ' + e.message);
    }
  });

app.post('/set-tariff', requireAuth, async (req, res) => {
  const { userId, limit, days, applyMode, opType, comment } = req.body;
  try {
    const isUnlimited = limit === 'unlim' || limit === 'unlimited';
    const newLimit = isUnlimited ? null : parseInt(limit, 10);
    if (!isUnlimited && (!Number.isInteger(newLimit) || newLimit < 0)) {
      return res.status(400).send('Некорректный лимит тарифа.');
    }
    const nDays = parseInt(days, 10) || 30;
    const mode = applyMode === 'extend' ? 'extend' : 'set';

    const updated = await setTariffAdmin(userId, newLimit, nDays, { 
      mode,
      opType: opType || 'adjustment',
      performedByType: 'admin',
      performedByUserId: 0, // ID администратора (системный)
      comment: comment || null
    });

    await logUserAction(userId, 'tariff_changed_by_admin', {
      new_limit: newLimit,
      days: nDays,
      mode,
      op_type: opType || 'adjustment',
      comment: comment || null
    });

    const limitFree = parseInt(getSetting('daily_limit_free') || '3', 10);
    const limitPlus = parseInt(getSetting('daily_limit_plus') || '30', 10);
    const limitPro = parseInt(getSetting('daily_limit_pro') || '100', 10);

    let tariffName = '';
    if (newLimit === null) tariffName = 'Unlimited';
    else if (newLimit <= limitFree) tariffName = 'Free';
    else if (newLimit <= limitPlus) tariffName = 'Plus';
    else if (newLimit <= limitPro) tariffName = 'Pro';
    else tariffName = 'Unlimited';

    const untilText = !updated.premium_until
      ? 'бессрочно'
      : new Date(updated.premium_until).toLocaleString('ru-RU', {
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit'
        });

    const message =
      `🎉 Ваш тариф был обновлен администратором!\n\n` +
      `Новый тариф: *${tariffName}* (${newLimit === null ? 'без лимита' : `${newLimit} загрузок/день`}).\n` +
      `Срок действия: *${untilText}* ` +
      (mode === 'extend' ? '(продлён).' : '(установлен заново).');

    await bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error(`[Admin] Ошибка при смене тарифа для ${userId}:`, error.message);
  }
  
  // Если пришли из профиля — возвращаемся в профиль
  const referer = req.get('Referer') || '';
  if (referer.includes('/user/')) {
    res.redirect(`/user/${userId}?tariffUpdated=1`);
  } else {
    res.redirect('/users');
  }
});

app.post('/register-manual-payment', requireAuth, async (req, res) => {
  const adminId = 0; // Системный ID или ID сессии админа
  const { userId, plan, amountMinor, currency, paymentMethod, periodDays, comment } = req.body;

  const normalizedCurrency = String(currency || '').trim().toUpperCase();
  const normalizedPaymentMethod = String(paymentMethod || '').trim().toLowerCase();
  if (normalizedCurrency === 'XTR' || normalizedPaymentMethod === 'telegram_stars') {
    return res.status(400).send('Ошибка: Валюта Telegram Stars (XTR) не может быть зачислена вручную.');
  }

  try {
    const { processManualPayment } = await import('./db.js');
    const result = await processManualPayment({
      adminId,
      userId: parseInt(userId, 10),
      plan,
      amountMinor: parseInt(amountMinor, 10),
      currency: currency || 'RUB',
      paymentMethod,
      periodDays: parseInt(periodDays, 10) || 30,
      comment: comment || null
    });

    if (result && result.status === 'success') {
      // Отправляем уведомление пользователю в Telegram
      const { TARIFFS } = await import('./config/tariffs.js');
      const tariff = TARIFFS[plan];
      const name = tariff ? tariff.name : plan;
      const untilText = new Date(result.new_premium_until).toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow'
      });

      const message =
        `🎉 Администратор подтвердил ваш ручной платёж!\n\n` +
        `Вам активирован тариф: *${name}*.\n` +
        `Срок действия: *${untilText} (МСК)*.\n\n` +
        `_Спасибо за поддержку проекта! Приятного скачивания!_`;

      await bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' }).catch((err) => {
        console.error('[Admin] Не удалось отправить уведомление пользователю:', err.message);
      });
    } else {
      console.error('[Admin] Ошибка регистрации платежа:', result);
    }
  } catch (error) {
    console.error('[Admin] Ошибка в /register-manual-payment:', error.message);
  }

  const referer = req.get('Referer') || '';
  if (referer.includes('/user/')) {
    res.redirect(`/user/${userId}?paymentRegistered=1`);
  } else {
    res.redirect('/users');
  }
});

app.get('/admin/analytics', requireAuth, async (req, res) => {
  const todayMskStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
  const defaultStart = new Date(Date.now() - 30 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
  const startDate = req.query.startDate || defaultStart;
  const endDate = req.query.endDate || todayMskStr;

  try {
    const { query } = await import('./db.js');
    const { getAnalyticsExcludedUserIds } = await import('./services/paymentLossAnalyticsService.js');
    const { getShazamAnalyticsData } = await import('./services/shazamReportService.js');
    const excludedAnalyticsUserIds = getAnalyticsExcludedUserIds();
    
    // 1. Детальная статистика по дням
    const dailyRowsRes = await query(
      `SELECT day, dau, wau, mau, registrations, downloads_total, downloads_from_cache, downloads_new, limits_reached, tariffs_shown, tariffs_clicked, payments_started, payments_completed, revenue_rub_minor, revenue_xtr
       FROM public.analytics_daily
       WHERE day BETWEEN $1 AND $2
       ORDER BY day DESC`,
      [startDate, endDate]
    );
    
    // Получаем информацию о последней агрегации
    let lastAggregation = { lastUpdate: null, minDay: null, maxDay: null };
    try {
      const lastAggRes = await query(
        `SELECT 
           MAX(updated_at) AS last_update, 
           MIN(day) AS min_day, 
           MAX(day) AS max_day 
         FROM public.analytics_daily`
      );
      if (lastAggRes.rows[0]) {
        const row = lastAggRes.rows[0];
        lastAggregation.lastUpdate = row.last_update ? new Date(row.last_update).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' МСК' : '—';
        lastAggregation.minDay = row.min_day ? new Date(row.min_day).toLocaleDateString('ru-RU', { timeZone: 'UTC' }) : '—';
        lastAggregation.maxDay = row.max_day ? new Date(row.max_day).toLocaleDateString('ru-RU', { timeZone: 'UTC' }) : '—';
      }
    } catch (aggInfoErr) {
      console.error('[Analytics] Error getting last aggregation info:', aggInfoErr.message);
    }
    const dailyRows = dailyRowsRes.rows;

    // 2. Агрегированные суммы воронки
    const funnelRes = await query(
      `SELECT 
         COALESCE(SUM(tariffs_shown), 0)::int AS total_shown,
         COALESCE(SUM(tariffs_clicked), 0)::int AS total_clicked,
         COALESCE(SUM(payments_started), 0)::int AS total_started,
         COALESCE(SUM(payments_completed), 0)::int AS total_completed,
         COALESCE(SUM(revenue_rub_minor), 0)::bigint AS total_rev_rub,
         COALESCE(SUM(revenue_xtr), 0)::bigint AS total_rev_xtr,
         COALESCE(SUM(downloads_total), 0)::int AS total_downloads,
         COALESCE(AVG(dau), 0)::int AS avg_dau
       FROM public.analytics_daily
       WHERE day BETWEEN $1 AND $2`,
      [startDate, endDate]
    );
    
    const funnel = funnelRes.rows[0];

    // 3. Распределение скачиваний пользователей
    const limitDistRes = await query(
      `SELECT downloads_count, COUNT(*)::int AS users_count
       FROM public.analytics_user_daily
       WHERE day BETWEEN $1 AND $2
         AND downloads_count > 0
       GROUP BY downloads_count
       ORDER BY downloads_count ASC`,
      [startDate, endDate]
    );
    const limitDistribution = limitDistRes.rows;

    // 4. Достигли лимита
    const reachedLimitRes = await query(
      `SELECT COUNT(DISTINCT user_id)::int AS count
       FROM public.analytics_events
       WHERE event_name = 'daily_limit_reached'
         AND created_at BETWEEN $1::date AND ($2::date + 1)
         AND NOT (user_id = ANY($3::bigint[]))`,
      [startDate, endDate, excludedAnalyticsUserIds]
    );
    const reachedLimit = reachedLimitRes.rows[0].count;

    // 5. Попытки скачать 6+ трек
    const attemptedOverLimitRes = await query(
      `SELECT COUNT(DISTINCT user_id)::int AS count
       FROM public.analytics_events
       WHERE event_name = 'download_attempt_over_limit'
         AND created_at BETWEEN $1::date AND ($2::date + 1)
         AND NOT (user_id = ANY($3::bigint[]))`,
      [startDate, endDate, excludedAnalyticsUserIds]
    );
    const attemptedOverLimit = attemptedOverLimitRes.rows[0].count;

    // 6. Открыли меню тарифов после лимита
    const openedOffersAfterLimitRes = await query(
      `SELECT COUNT(DISTINCT a.user_id)::int AS count
       FROM public.analytics_events a
       JOIN public.analytics_events b ON a.user_id = b.user_id AND b.event_name = 'daily_limit_reached' AND b.created_at < a.created_at
       WHERE a.event_name = 'star_payment_option_shown'
         AND a.created_at BETWEEN $1::date AND ($2::date + 1)
         AND NOT (a.user_id = ANY($3::bigint[]))`,
      [startDate, endDate, excludedAnalyticsUserIds]
    );
    const openedOffersAfterLimit = openedOffersAfterLimitRes.rows[0].count;

    // 7. Оплатили после лимита
    const paidAfterLimitRes = await query(
      `SELECT COUNT(DISTINCT a.user_id)::int AS count
       FROM public.payments a
       JOIN public.analytics_events b ON a.user_id = b.user_id AND b.event_name = 'daily_limit_reached' AND b.created_at < a.paid_at
       WHERE a.payment_status = 'completed'
         AND a.paid_at BETWEEN $1::date AND ($2::date + 1)
         AND NOT (a.user_id = ANY($3::bigint[]))`,
      [startDate, endDate, excludedAnalyticsUserIds]
    );
    const paidAfterLimit = paidAfterLimitRes.rows[0].count;

    // 8. Вернулись на следующий день после лимита
    const returnedNextDayRes = await query(
      `SELECT COUNT(DISTINCT a.user_id)::int AS count
       FROM public.analytics_events a
       JOIN public.analytics_events b ON a.user_id = b.user_id AND b.event_name = 'daily_limit_reached'
       WHERE a.created_at::date = b.created_at::date + 1
         AND b.created_at BETWEEN $1::date AND ($2::date + 1)
         AND NOT (a.user_id = ANY($3::bigint[]))`,
      [startDate, endDate, excludedAnalyticsUserIds]
    );
    const returnedNextDay = returnedNextDayRes.rows[0].count;

    // 9. Прекратили активность (отток) после лимита
    const churnedAfterLimitRes = await query(
      `SELECT COUNT(DISTINCT e.user_id)::int AS count
       FROM public.analytics_events e
       WHERE event_name = 'daily_limit_reached'
         AND created_at BETWEEN $1::date AND ($2::date + 1)
         AND NOT (e.user_id = ANY($3::bigint[]))
         AND NOT EXISTS (
           SELECT 1 FROM public.analytics_events a
           WHERE a.user_id = e.user_id
             AND a.created_at > e.created_at
         )`,
      [startDate, endDate, excludedAnalyticsUserIds]
    );
    const churnedAfterLimit = churnedAfterLimitRes.rows[0].count;

    const { getAIRecommendationsData } = await import('./db.js');
    const growthData = await getAIRecommendationsData();
    const shazam = await getShazamAnalyticsData({
      query,
      startDate,
      endDate,
      excludedUserIds: excludedAnalyticsUserIds
    });

    res.render('analytics', {
      layout: 'layout',
      page: 'analytics',
      startDate,
      endDate,
      dailyRows,
      avgDau: funnel.avg_dau,
      totalRevRub: funnel.total_rev_rub,
      totalRevXtr: funnel.total_rev_xtr,
      totalDownloads: funnel.total_downloads,
      totalShown: funnel.total_shown,
      totalClicked: funnel.total_clicked,
      totalStarted: funnel.total_started,
      totalCompleted: funnel.total_completed,
      limitDistribution,
      reachedLimit,
      attemptedOverLimit,
      openedOffersAfterLimit,
      paidAfterLimit,
      returnedNextDay,
      churnedAfterLimit,
      lastAggregation,
      growthData,
      shazam,
      unreadSupportCount: res.locals.unreadSupportCount || 0
    });
  } catch (error) {
    console.error('[Admin] Error rendering analytics:', error.message);
    res.status(500).send('Ошибка загрузки аналитики: ' + error.message);
  }
});

let aggregationState = {
  active: false,
  totalDays: 0,
  currentDayIndex: 0,
  currentDay: null,
  error: null
};

async function runPeriodAggregationInBackground(startDateStr, endDateStr) {
  if (aggregationState.active) return;
  aggregationState.active = true;
  aggregationState.error = null;

  try {
    const start = new Date(startDateStr);
    const end = new Date(endDateStr);
    
    const dates = [];
    let current = new Date(start);
    while (current <= end) {
      dates.push(current.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' }));
      current.setDate(current.getDate() + 1);
    }

    aggregationState.totalDays = dates.length;
    aggregationState.currentDayIndex = 0;

    const { aggregateDailyStats } = await import('./db.js');

    for (const dateStr of dates) {
      aggregationState.currentDay = dateStr;
      console.log(`[Period Aggregation] Progress: ${aggregationState.currentDayIndex + 1}/${dates.length} (${dateStr})`);
      await aggregateDailyStats(dateStr);
      aggregationState.currentDayIndex++;
    }
    
    console.log(`[Period Aggregation] Completed successfully for ${dates.length} days.`);
  } catch (err) {
    console.error('[Period Aggregation] Failed:', err);
    aggregationState.error = err.message;
  } finally {
    aggregationState.active = false;
    aggregationState.currentDay = null;
  }
}

app.post('/admin/analytics/aggregate-day', requireAuth, async (req, res) => {
  if (aggregationState.active) {
    return res.status(400).json({ ok: false, error: 'Агрегация уже выполняется.' });
  }
  const { targetDate } = req.body;
  if (!targetDate) {
    return res.status(400).json({ ok: false, error: 'Укажите дату YYYY-MM-DD.' });
  }

  try {
    const { aggregateDailyStats } = await import('./db.js');
    await aggregateDailyStats(targetDate);
    res.json({ ok: true, aggregated: targetDate });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/admin/analytics/aggregate-period', requireAuth, async (req, res) => {
  if (aggregationState.active) {
    return res.status(400).json({ ok: false, error: 'Агрегация уже выполняется.' });
  }
  const { startDate, endDate } = req.body;
  if (!startDate || !endDate) {
    return res.status(400).json({ ok: false, error: 'Укажите дату начала и окончания периода.' });
  }

  runPeriodAggregationInBackground(startDate, endDate);
  res.json({ ok: true, message: 'Агрегация периода запущена в фоновом режиме.' });
});

app.post('/admin/analytics/backfill', requireAuth, async (req, res) => {
  if (aggregationState.active) {
    return res.status(400).json({ ok: false, error: 'Агрегация уже выполняется.' });
  }
  try {
    const { backfillMissingDays } = await import('./db.js');
    backfillMissingDays().catch(console.error);
    res.json({ ok: true, message: 'Восстановление пропущенных дней запущено.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/admin/analytics/status', requireAuth, (req, res) => {
  res.json(aggregationState);
});

app.post('/admin/analytics/smoke-test', requireAuth, async (req, res) => {
  try {
    const result = await runAnalyticsSmokeTest();
    res.status(result.ok ? 200 : 500).json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      summary: { passed: 0, failed: 1 },
      tests: {
        smoke_runner: { status: 'error', error: error.message }
      }
    });
  }
});

app.post('/admin/system/self-test', requireAuth, async (req, res) => {
  try {
    const result = await runSystemSelfTest();
    res.status(result.ok ? 200 : 503).json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      database: 'error',
      analytics: 'error',
      broadcasts: 'error',
      workers: 'error',
      excel: 'error',
      error: error.message
    });
  }
});

app.get('/admin/analytics/export', requireAuth, async (req, res) => {
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) {
    return res.status(400).send('Укажите startDate и endDate в параметрах запроса.');
  }

  try {
    const { getExcelAnalyticsData } = await import('./db.js');
    const data = await getExcelAnalyticsData(startDate, endDate);
    const artifact = await generateExcelReport(data, { startDate, endDate });

    console.log(`[Analytics Export] XLSX generated (${artifact.size} bytes).`);
    res.download(
      artifact.xlsxPath,
      `SCM_Analytics_${startDate}_${endDate}.xlsx`,
      async (downloadError) => {
        await artifact.cleanup().catch(cleanupError => {
          console.error('[Analytics Export] Cleanup error:', cleanupError.message);
        });
        if (downloadError) console.error('[Analytics Export] Download error:', downloadError.message);
      }
    );
  } catch (error) {
    console.error('[Analytics Export] Error:', error.details || error.message);
    if (!res.headersSent) res.status(500).send('Ошибка экспорта: ' + (error.details || error.message));
  }
});

app.get('/admin/analytics/compare', requireAuth, async (req, res) => {
  const { startA, endA, startB, endB } = req.query;
  if (!startA || !endA || !startB || !endB) {
    return res.status(400).json({ ok: false, error: 'Укажите диапазоны startA, endA, startB, endB.' });
  }
  try {
    const { getPeriodComparisonData } = await import('./db.js');
    const data = await getPeriodComparisonData(startA, endA, startB, endB);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin/analytics/cohorts', requireAuth, async (req, res) => {
  try {
    const { getCohortRetentionData } = await import('./db.js');
    const data = await getCohortRetentionData();
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin/analytics/revenue', requireAuth, async (req, res) => {
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) {
    return res.status(400).json({ ok: false, error: 'Укажите startDate и endDate.' });
  }
  try {
    const { getRevenueDashboardData } = await import('./db.js');
    const data = await getRevenueDashboardData(startDate, endDate);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin/analytics/payment-loss', requireAuth, async (req, res) => {
  try {
    const { getPaymentLossAnalytics } = await import('./services/paymentLossAnalyticsService.js');
    res.json(await getPaymentLossAnalytics(req.query));
  } catch (error) {
    const isValidationError = /startDate|Date range/i.test(error.message);
    console.error('[PaymentLoss] Analytics error:', error.message);
    res.status(isValidationError ? 400 : 500).json({ ok: false, error: error.message });
  }
});

app.get('/admin/analytics/payment-loss/users', requireAuth, async (req, res) => {
  try {
    const { getPaymentLossUsers } = await import('./services/paymentLossAnalyticsService.js');
    res.json(await getPaymentLossUsers(req.query));
  } catch (error) {
    const isValidationError = /startDate|Date range/i.test(error.message);
    console.error('[PaymentLoss] Drilldown error:', error.message);
    res.status(isValidationError ? 400 : 500).json({ ok: false, error: error.message });
  }
});

app.get('/admin/user-journey', requireAuth, (req, res) => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
  const monthAgo = new Date(Date.now() - 29 * 86_400_000)
    .toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
  res.render('user-journey', {
    title: 'Путь пользователя',
    page: 'user-journey',
    initialUserId: String(req.query.user_id || '').trim(),
    defaultStartDate: monthAgo,
    defaultEndDate: today
  });
});

app.get('/admin/api/user-journey/:userId', requireAuth, async (req, res) => {
  try {
    const { getUserTimeline } = await import('./services/userInsightsService.js');
    const resolved = await resolveUserIdentifier(req.params.userId, query);
    if (!resolved) return res.status(404).json({ ok: false, error: 'Пользователь не найден.' });
    const data = await getUserTimeline(resolved.id, {
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      limit: req.query.limit,
      beforeOccurredAt: req.query.beforeOccurredAt,
      beforeEventId: req.query.beforeEventId
    });
    if (!data) return res.status(404).json({ ok: false, error: 'Пользователь не найден.' });
    res.json({ ok: true, data });
  } catch (error) {
    const status = /user_id|startDate|endDate|limit|beforeOccurredAt|beforeEventId|формат|некоррект|диапазон/i.test(error.message) ? 400 : 500;
    res.status(status).json({ ok: false, error: error.message });
  }
});

app.get('/admin/api/retention-explorer', requireAuth, async (req, res) => {
  try {
    const { getRetentionExplorer } = await import('./services/userInsightsService.js');
    const data = await getRetentionExplorer({ ...req.query, view: 'summary' });
    res.json({ ok: true, data });
  } catch (error) {
    const status = /startDate|endDate|source|позже|диапазон/i.test(error.message) ? 400 : 500;
    res.status(status).json({ ok: false, error: error.message });
  }
});

app.get('/admin/api/retention-explorer/users', requireAuth, async (req, res) => {
  try {
    const { getRetentionExplorer } = await import('./services/userInsightsService.js');
    const data = await getRetentionExplorer({ ...req.query, view: 'users' });
    res.json({ ok: true, data });
  } catch (error) {
    const status = /startDate|endDate|source|day|segment|page|limit|Поддерживаются|позже|диапазон/i.test(error.message) ? 400 : 500;
    res.status(status).json({ ok: false, error: error.message });
  }
});

app.get('/admin/api/acquisition-sources', requireAuth, async (req, res) => {
  try {
    const { getAcquisitionSourceExplorer } = await import('./services/userInsightsService.js');
    const data = await getAcquisitionSourceExplorer(req.query);
    res.json({ ok: true, data });
  } catch (error) {
    const status = /startDate|endDate|source|позже|диапазон/i.test(error.message) ? 400 : 500;
    res.status(status).json({ ok: false, error: error.message });
  }
});

  app.post('/reset-bonus', requireAuth, async (req, res) => {
    const { userId } = req.body;
    if (userId) { await updateUserField(userId, 'subscribed_bonus_used', false); }
    const back = req.get('Referer') || '/users';
    res.redirect(back);
  });

  app.post('/reset-daily-limit', requireAuth, async (req, res) => {
    const { userId } = req.body;
    if (userId) {
      await updateUserField(userId, 'downloads_today', 0);
      await updateUserField(userId, 'tracks_today', []);
    }
    const back = req.get('Referer') || '/users';
    res.redirect(back);
  });
app.post('/tariffs/reset-others', requireAuth, async (req, res) => {
  try {
    const n = await resetOtherTariffsToFree();
    res.redirect('/dashboard?resetOthers=' + n);
  } catch (e) {
    console.error('[Tariffs] reset-others error:', e);
    res.redirect('/dashboard?resetOthers=err');
  }
});
  app.post('/user/set-status', requireAuth, async (req, res) => {
    const { userId, newStatus } = req.body;
    if (userId && (newStatus === 'true' || newStatus === 'false')) {
      try {
        const isActive = newStatus === 'true';
        await updateUserField(userId, 'active', isActive);
        const actionType = isActive ? 'unbanned_by_admin' : 'banned_by_admin';
        await logUserAction(userId, actionType);
        if (isActive) {
          await bot.telegram.sendMessage(userId, '✅ Ваш аккаунт снова активен.').catch(() => {});
        }
      } catch (error) {
        console.error(`[Admin] Ошибка при смене статуса для ${userId}:`, error.message);
      }
    }
    const back = req.get('Referer') || '/users';
    res.redirect(back);
  });
// 1. Скачать список ссылок
  app.get('/admin/user/:id/links', requireAuth, async (req, res) => {
    try {
      const userId = req.params.id;
      const urls = await getUserUniqueDownloadedUrls(userId);
      
      if (!urls || urls.length === 0) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8'); // Важно для корректного отображения текста
        return res.send('История скачиваний пуста.');
      }

      const content = urls.join('\n');
      res.setHeader('Content-Disposition', `attachment; filename="links_${userId}.txt"`);
      res.setHeader('Content-Type', 'text/plain');
      res.send(content);
    } catch (e) {
      console.error(e);
      res.status(500).send('Ошибка при генерации списка ссылок');
    }
  });

   // 2. Починить кэш
  app.post('/admin/user/:id/fix-cache', requireAuth, async (req, res) => {
    try {
      const userId = req.params.id;
      const { fixDate } = req.body;

      const count = await fixBadCacheForUser(userId, fixDate);
      
      res.redirect(`/user/${userId}?fixedCount=${count}&fixedDate=${fixDate}`);
    } catch (e) {
      console.error(e);
      res.status(500).send('Ошибка при исправлении кэша: ' + e.message);
    }
  });

  // Ручной запуск агрегации аналитики
  app.post('/admin/run-aggregation', requireAuth, async (req, res) => {
    try {
      const { targetDate } = req.body; // YYYY-MM-DD, если не передан — сегодня МСК
      const label = targetDate || new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
      console.log(`[Admin] Ручной запуск агрегации аналитики за ${label}...`);
      await aggregateDailyStats(targetDate || null);
      console.log(`[Admin] Агрегация за ${label} завершена.`);
      res.json({ ok: true, aggregated: label });
    } catch (e) {
      console.error('[Admin] Ошибка агрегации:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

} 

// Запускаем приложение
startApp();
