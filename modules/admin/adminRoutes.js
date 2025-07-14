import express from 'express';
import multer from 'multer';
import * as json2csv from '@json2csv/node';
import fs from 'fs';
import path from 'path';

import { ADMIN_ID, ADMIN_LOGIN, ADMIN_PASSWORD, WEBHOOK_URL } from '../config/env.js';
import { requireAuth } from './authMiddleware.js';
import { getAllUsers, getUserById, setPremium, updateUserField } from '../db/userRepository.js';
import { getFunnelData, getRegistrationsByDate, getDownloadsByDate, getActiveUsersByDate, getUserActivityByDayHour, getExpiringUsersPaginated, getExpiringUsersCount, getReferralSourcesStats } from '../db/statsRepository.js';
import { broadcastMessage } from '../bot/broadcastHandler.js';
import bot from '../bot/bot.js'; // Import the bot instance

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

// ===== Утилиты для фильтрации статистики =====

// Конвертация объекта {date: count, ...} в массив [{date, count}, ...]
function convertObjToArray(dataObj) {
  if (!dataObj) return [];
  return Object.entries(dataObj).map(([date, count]) => ({ date, count }));
}

// Фильтрация массива статистики по периоду (число дней или 'YYYY-MM')
function filterStatsByPeriod(data, period) {
  if (!Array.isArray(data)) return [];

  const now = new Date();

  // Если period — число дней
  if (!isNaN(period)) {
    const days = parseInt(period);
    const cutoff = new Date(now.getTime() - days * 86400000);
    return data.filter(item => new Date(item.date) >= cutoff);
  }

  // Если period — формат 'YYYY-MM'
  if (/^\d{4}-\d{2}$/.test(period)) {
    return data.filter(item => item.date && item.date.startsWith(period));
  }

  // Иначе возвращаем все данные
  return data;
}

// Подготовка данных для графиков Chart.js из трёх массивов с датами и значениями
function prepareChartData(registrations, downloads, active) {
  const dateSet = new Set([
    ...registrations.map(r => r.date),
    ...downloads.map(d => d.date),
    ...active.map(a => a.date)
  ]);
  const dates = Array.from(dateSet).sort();

  const regMap = new Map(registrations.map(r => [r.date, r.count]));
  const dlMap = new Map(downloads.map(d => [d.date, d.count]));
  const actMap = new Map(active.map(a => [a.date, a.count]));

  return {
    labels: dates,
    datasets: [
      {
        label: 'Регистрации',
        data: dates.map(d => regMap.get(d) || 0),
        borderColor: 'rgba(75, 192, 192, 1)',
        backgroundColor: 'rgba(75, 192, 192, 0.2)',
        fill: false,
      },
      {
        label: 'Загрузки',
        data: dates.map(d => dlMap.get(d) || 0),
        borderColor: 'rgba(255, 99, 132, 1)',
        backgroundColor: 'rgba(255, 99, 132, 0.2)',
        fill: false,
      },
      {
        label: 'Активные пользователи',
        data: dates.map(d => actMap.get(d) || 0),
        borderColor: 'rgba(54, 162, 235, 1)',
        backgroundColor: 'rgba(54, 162, 235, 0.2)',
        fill: false,
      }
    ]
  };
}

// Получение последних N месяцев в виде [{value: 'YYYY-MM', label: 'Месяц Год'}, ...]
function getLastMonths(count = 6) {
  const months = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const value = d.toISOString().slice(0, 7); // 'YYYY-MM'
    const label = d.toLocaleString('ru-RU', { month: 'long', year: 'numeric' });
    months.push({ value, label });
  }
  return months;
}

// Получение диапазона дат по периоду (число дней или 'YYYY-MM')
function getFromToByPeriod(period) {
  const now = new Date();
  if (!isNaN(period)) {
    const days = parseInt(period);
    return {
      from: new Date(now.getTime() - days * 86400000),
      to: now
    };
  } else if (/^\d{4}-\d{2}$/.test(period)) {
    const [year, month] = period.split('-').map(Number);
    const from = new Date(year, month - 1, 1);
    const to = new Date(year, month, 1);
    return { from, to };
  } else {
    throw new Error('Некорректный формат периода');
  }
}

// activityByDayHour — объект вида { "2025-07-01": {0: 5, 1: 3, ...}, "2025-07-02": {...} }
function computeActivityByHour(activityByDayHour) {
  const hours = Array(24).fill(0);
  for (const day in activityByDayHour) {
    const hoursData = activityByDayHour[day];
    for (let h = 0; h < 24; h++) {
      hours[h] += hoursData[h] || 0;
    }
  }
  return hours;
}

function computeActivityByWeekday(activityByDayHour) {
  const weekdays = Array(7).fill(0); // Воскресенье = 0, понедельник = 1 и т.д.
  for (const dayStr in activityByDayHour) {
    const date = new Date(dayStr);
    const weekday = date.getDay();
    const hoursData = activityByDayHour[dayStr];
    const dayTotal = Object.values(hoursData).reduce((a,b) => a+b, 0);
    weekdays[weekday] += dayTotal;
  }
  return weekdays;
}

// Вход в админку
router.get('/admin', (req, res) => {
  if (req.session.authenticated && req.session.userId === ADMIN_ID) {
    return res.redirect('/dashboard');
  }
  res.locals.page = 'admin';
  res.render('login', { title: 'Вход в админку', error: null });
});

router.post('/admin', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_LOGIN && password === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    req.session.userId = ADMIN_ID;
    res.redirect('/dashboard');
  } else {
    res.locals.page = 'admin';
    res.render('login', { title: 'Вход в админку', error: 'Неверный логин или пароль' });
  }
});

// Дашборд
router.get('/health', (req, res) => res.send('OK'));
router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    res.locals.page = 'dashboard';

    const showInactive = req.query.showInactive === 'true';
    const period = req.query.period || '30';
    const expiringLimit = parseInt(req.query.expiringLimit) || 10;
    const expiringOffset = parseInt(req.query.expiringOffset) || 0;

    const expiringSoon = await getExpiringUsersPaginated(expiringLimit, expiringOffset);
    const expiringCount = await getExpiringUsersCount();
    const users = await getAllUsers(showInactive);

    const downloadsByDateRaw = await getDownloadsByDate();
    const registrationsByDateRaw = await getRegistrationsByDate();
    const activeByDateRaw = await getActiveUsersByDate();

    const filteredRegistrations = filterStatsByPeriod(convertObjToArray(registrationsByDateRaw), period);
    const filteredDownloads = filterStatsByPeriod(convertObjToArray(downloadsByDateRaw), period);
    const filteredActive = filterStatsByPeriod(convertObjToArray(activeByDateRaw), period);

    const chartDataCombined = prepareChartData(filteredRegistrations, filteredDownloads, filteredActive);

    const stats = {
      totalUsers: users.length,
      totalDownloads: users.reduce((sum, u) => sum + (u.total_downloads || 0), 0),
      free: users.filter(u => u.premium_limit === 5).length,
      plus: users.filter(u => u.premium_limit === 25).length,
      pro: users.filter(u => u.premium_limit === 50).length,
      unlimited: users.filter(u => u.premium_limit >= 1000).length,
      registrationsByDate: filteredRegistrations,
      downloadsByDate: filteredDownloads,
      activeByDate: filteredActive
    };

    const activityByDayHour = await getUserActivityByDayHour();
    const activityByHour = computeActivityByHour(activityByDayHour);
    const activityByWeekday = computeActivityByWeekday(activityByDayHour);

    const referralStats = await getReferralSourcesStats();

    const { from: fromDate, to: toDate } = getFromToByPeriod(period);
    const funnelCounts = await getFunnelData(fromDate.toISOString(), toDate.toISOString());

    const chartDataFunnel = {
      labels: ['Зарегистрировались', 'Скачали', 'Оплатили'],
      datasets: [{
        label: 'Воронка пользователей',
        data: [
          funnelCounts.registrationCount || 0,
          funnelCounts.firstDownloadCount || 0,
          funnelCounts.subscriptionCount || 0
        ],
        backgroundColor: ['#2196f3', '#4caf50', '#ff9800']
      }]
    };

    const chartDataHourActivity = {
      labels: [...Array(24).keys()].map(h => `${h}:00`),
      datasets: [{
        label: 'Активность по часам',
        data: activityByHour,
        backgroundColor: 'rgba(54, 162, 235, 0.7)',
      }]
    };

    const chartDataWeekdayActivity = {
      labels: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
      datasets: [{
        label: 'Активность по дням недели',
        data: activityByWeekday,
        backgroundColor: 'rgba(255, 206, 86, 0.7)',
      }]
    };

    const chartDataDownloads = {
      labels: chartDataCombined.labels,
      datasets: [chartDataCombined.datasets[1]] // Только "Загрузки"
    };

    const lastMonths = getLastMonths(6);
    // Retention data query (assuming pool is available globally or passed)
    // This part needs to be adapted if pool is not globally available
    // For now, I'll comment it out or simplify it if it depends on `pool` directly.
    // const retentionResult = await pool.query(`...`);
    // const retentionRows = retentionResult.rows;

    // const cohortsMap = {};
    // retentionRows.forEach(row => {
    //   const date = row.cohort_date.toISOString().split('T')[0];
    //   if (!cohortsMap[date]) {
    //     cohortsMap[date] = { label: date, data: { 0: null, 1: null, 3: null, 7: null, 14: null } };
    //   }
    //   cohortsMap[date].data[row.days_since_signup] = row.retention_percent;
    // });

    const chartDataRetention = {
      labels: ['Day 0', 'Day 1', 'Day 3', 'Day 7', 'Day 14'],
      datasets: [] // Object.values(cohortsMap).map(cohort => ({...
    };

    res.render('dashboard', {
      title: 'Панель управления',
      stats,
      users,
      referralStats,
      expiringSoon,
      expiringCount,
      expiringOffset,
      expiringLimit,
      activityByHour,
      activityByWeekday,
      chartDataCombined,
      chartDataHourActivity,
      chartDataWeekdayActivity,
      showInactive,
      period,
      retentionData: [],
      funnelData: funnelCounts,
      chartDataFunnel,
      chartDataRetention,
      chartDataUserFunnel: {},
      chartDataDownloads,
      lastMonths,
      customStyles: '',
      customScripts: '',
      chartDataHeatmap: {}
    });

  } catch (e) {
    console.error('❌ Ошибка при загрузке dashboard:', e);
    res.status(500).send('Внутренняя ошибка сервера');
  }
});

// Выход
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin');
  });
});

// Рассылка
router.get('/broadcast', requireAuth, (req, res) => {
  res.locals.page = 'broadcast';
  res.render('broadcast-form', { title: 'Рассылка', error: null });
});

router.post('/broadcast', requireAuth, upload.single('audio'), async (req, res) => {
  const { message } = req.body;
  const audio = req.file;

  if (!message && !audio) {
    res.locals.page = 'broadcast';
    return res.status(400).render('broadcast-form', { error: 'Текст или файл обязательны' });
  }

  let audioBuffer = null;

  // Читаем файл один раз в память
  if (audio) {
    try {
      audioBuffer = fs.readFileSync(audio.path);
    } catch (err) {
      console.error('❌ Ошибка чтения аудиофайла:', err);
      res.locals.page = 'broadcast';
      return res.status(500).render('broadcast-form', { error: 'Ошибка при чтении файла' });
    }
  }

  const { successCount, errorCount } = await broadcastMessage(message, audioBuffer ? { buffer: audioBuffer, originalname: audio.originalname } : null);

  // Удаляем файл после загрузки в память
  if (audio) {
    fs.unlink(audio.path, err => {
      if (err) console.error('Ошибка удаления аудио:', err);
      else console.log(`🗑 Удалён файл рассылки: ${audio.originalname}`);
    });
  }

  // Отправляем администратору отчет
  try {
    await bot.telegram.sendMessage(ADMIN_ID, `📣 Рассылка завершена\n✅ Успешно: ${successCount}\n❌ Ошибок: ${errorCount}`);
  } catch (err) {
    console.error('Ошибка отправки уведомления админу:', err);
  }

  // Отдаем страницу с результатом
  res.locals.page = 'broadcast';
  res.render('broadcast-form', {
    title: 'Рассылка',
    success: successCount,
    error: errorCount,
    errorMessage: null,
  });
});

// Экспорт пользователей CSV
router.get('/export', requireAuth, async (req, res) => {
  try {
    res.locals.page = 'export';
    const allUsers = await getAllUsers(true);
    const period = req.query.period || 'all';

    const filteredUsers = allUsers.filter(user => {
      if (period === 'all') return true;
      if (period === '7' || period === '30') {
        const from = new Date(Date.now() - parseInt(period) * 86400000);
        return new Date(user.created_at) >= from;
      }
      if (period.startsWith('month:')) {
        const ym = period.split(':')[1]; // 'YYYY-MM'
        return user.created_at.startsWith(ym);
      }
      return true;
    });

    const fields = ['id', 'username', 'first_name', 'total_downloads', 'premium_limit', 'created_at', 'last_active'];
    const parser = new json2csv.Parser({ fields });
    const csv = parser.parse(filteredUsers);

    res.header('Content-Type', 'text/csv');
    res.attachment(`users_${period}.csv`);
    res.send(csv);
  } catch (e) {
    console.error('Ошибка экспорта CSV:', e);
    res.status(500).send('Ошибка сервера');
  }
});

// Пользователи с истекающим тарифом
router.get('/expiring-users', requireAuth, async (req, res) => {
  res.locals.page = 'expiring-users';
  const page = parseInt(req.query.page) || 1;
  const perPage = parseInt(req.query.perPage) || 10;

  try {
    const total = await getExpiringUsersCount();
    const users = await getExpiringUsersPaginated(perPage, (page - 1) * perPage);
    const totalPages = Math.ceil(total / perPage);

    res.render('expiring-users', {
      title: 'Истекающие подписки',
      users,
      page,
      perPage,
      totalPages
    });
  } catch (e) {
    console.error('Ошибка загрузки expiring-users:', e);
    res.status(500).send('Внутренняя ошибка сервера');
  }
});

router.post('/set-tariff', express.urlencoded({ extended: true }), requireAuth, async (req, res) => {
  const { userId, limit } = req.body;
  if (!userId || !limit) return res.status(400).send('Отсутствуют параметры');

  let limitNum = parseInt(limit);
  if (![10, 50, 100, 1000].includes(limitNum)) {
    return res.status(400).send('Неизвестный тариф');
  }

  try {
    // Например, здесь всегда 30 дней — можно кастомизировать
    const bonusApplied = await setPremium(userId, limitNum, 30);

    // (Опционально) можно уведомить пользователя о подарке:
    const user = await getUserById(userId);
    if (user) {
      let msg = '✅ Подписка активирована на 30 дней.\n';
      if (bonusApplied) msg += '🎁 +30 дней в подарок! Акция 1+1 применена.';
      await bot.telegram.sendMessage(userId, msg);
    }

    res.redirect('/dashboard');
  } catch (e) {
    console.error('Ошибка установки тарифа:', e);
    res.status(500).send('Ошибка сервера');
  }
});

router.post('/admin/reset-promo/:id', requireAuth, async (req, res) => {
  const userId = req.params.id;
  await updateUserField(userId, 'promo_1plus1_used', false);
  res.redirect('/dashboard');
});

export default router;
