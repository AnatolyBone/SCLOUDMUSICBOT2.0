import compression from 'compression';
import express from 'express';
import session from 'express-session';
import ejs from 'ejs';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import util from 'util';
import NodeID3 from 'node-id3';
import pgSessionFactory from 'connect-pg-simple';
import * as json2csv from '@json2csv/node';
import expressLayouts from 'express-ejs-layouts';
import https from 'https';

// Модули конфигурации и утилит
import { BOT_TOKEN, ADMIN_ID, WEBHOOK_URL, WEBHOOK_PATH, PORT, ADMIN_LOGIN, ADMIN_PASSWORD } from './modules/config/env.js';
import { cleanCache } from './modules/cache/trackCache.js';

// Модули базы данных
import { pool, supabase, query } from './modules/db/dbClient.js';
import { createUser, getUser, updateUserField, getAllUsers, getUserById, markSubscribedBonusUsed, setPremium, addOrUpdateUserInSupabase } from './modules/db/userRepository.js';
import { getFunnelData, getRegistrationsByDate, getDownloadsByDate, getActiveUsersByDate, getUserActivityByDayHour, getExpiringUsersPaginated, getExpiringUsersCount, getReferralSourcesStats, resetDailyStats } from './modules/db/statsRepository.js';
import { incrementDownloads, saveTrackForUser, resetDailyLimitIfNeeded } from './modules/db/trackRepository.js';
import { logEvent } from './modules/db/logRepository.js';

// Модули бота
import bot from './modules/bot/bot.js';
import { broadcastMessage } from './modules/bot/broadcastHandler.js';

// Модули админ-панели
import { setupAuthMiddleware } from './modules/admin/authMiddleware.js';
import adminRoutes from './modules/admin/adminRoutes.js';

// Инициализация сессии для pg
const pgSession = pgSessionFactory(session);

const upload = multer({ dest: 'uploads/' });

// Утилиты
const writeID3 = util.promisify(NodeID3.write);

if (!BOT_TOKEN || !ADMIN_ID || !ADMIN_LOGIN || !ADMIN_PASSWORD) {
  console.error('❌ Отсутствуют необходимые переменные окружения!');
  process.exit(1);
}

if (isNaN(ADMIN_ID)) {
  console.error('❌ ADMIN_ID должен быть числом');
  process.exit(1);
}

const app = express();

// Кеш треков — для ESM используем import.meta.url
const __filename = path.resolve(process.argv[1]);
const __dirname = path.dirname(__filename);

const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

setInterval(() => cleanCache(cacheDir), 3600 * 1000);
setInterval(() => resetDailyStats(), 24 * 3600 * 1000);

// === Настройка Express ===
app.use((req, res, next) => {
  res.locals.user = req.user || null;
  res.locals.page = null;        // по умолчанию пусто
  res.locals.title = 'Админка';
  next();
});

app.use(compression());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(expressLayouts); // Используем layout
app.set('view engine', 'ejs'); // Указываем движок шаблонов
app.set('views', path.join(__dirname, 'views')); // Папка с шаблонами
app.set('layout', 'layout');

// Обслуживание статических файлов из папки 'public'
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

setupAuthMiddleware(app); // Подключаем middleware аутентификации

// Подключаем маршруты админ-панели
app.use('/', adminRoutes);

// === Telegraf bot webhook ===
app.post(WEBHOOK_PATH, express.json(), (req, res) => {
  res.sendStatus(200);
  bot.handleUpdate(req.body).catch(err => console.error('Ошибка handleUpdate:', err));
});

// Запуск сервера и webhook бота
(async () => {
  try {
    await bot.telegram.setWebhook(`${WEBHOOK_URL}${WEBHOOK_PATH}`);
    app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
    console.log('🤖 Бот запущен и ожидает обновлений...');
  } catch (e) {
    console.error('Ошибка при старте:', e);
    process.exit(1);
  }
})();
