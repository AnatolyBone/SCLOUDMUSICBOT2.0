// db.js (актуальная версия)

import { Pool } from 'pg';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SUPABASE_URL, SUPABASE_KEY, DATABASE_URL, KARAOKE_DATABASE_URL, KARAOKE_SUPABASE_URL, KARAOKE_SUPABASE_KEY } from './config.js';
import { SUPPORTED_LANGUAGES } from './config/languages.js';
import { countUndeliverableRecipients } from './services/broadcastAudienceRules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(
      SUPABASE_URL,
      SUPABASE_KEY,
      {
        realtime: {
          transport: ws
        }
      }
    )
  : null;
export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  allowExitOnIdle: false
});

// --- KARAOKE LRC MAKER SEPARATE CONNECTION POOL & CLIENT ---
export const karaokePool = KARAOKE_DATABASE_URL
  ? new Pool({
      connectionString: KARAOKE_DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      allowExitOnIdle: false
    })
  : null;

if (karaokePool) {
  karaokePool.on('error', (err) => {
    console.error('⚠️ [Karaoke Pool] Ошибка idle-клиента:', err.message);
  });
}

export const karaokeSupabase = (KARAOKE_SUPABASE_URL && KARAOKE_SUPABASE_KEY)
  ? createClient(
      KARAOKE_SUPABASE_URL,
      KARAOKE_SUPABASE_KEY,
      {
        realtime: {
          transport: ws
        }
      }
    )
  : null;

export async function karaokeQuery(text, params) {
  if (!karaokePool) {
    return await query(text, params);
  }
  const start = Date.now();
  try {
    const res = await karaokePool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      console.log('[DB] [Karaoke] Slow query:', { text, duration, rows: res.rowCount });
    }
    return res;
  } catch (err) {
    console.error('[DB] [Karaoke] Query error:', err.message, 'SQL:', text);
    throw err;
  }
}

pool.on('error', (err) => {
  console.error('⚠️ [Pool] Ошибка idle-клиента:', err.message);
});

export async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (e) {
    console.error('❌ Ошибка запроса к БД:', e.message, { query: text });
    throw e;
  }
}
/**
 * Экранирует спецсимволы для CSV-формата
 */
function escapeCsv(value) {
  if (value == null) return '';
  const str = String(value);
  
  // Если содержит запятую, кавычки или перевод строки - оборачиваем в кавычки
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  
  return str;
}
// Сброс дневного лимита для конкретного пользователя, если наступил новый день
export async function resetDailyLimitIfNeeded(userId) {
  // проверяем дату последнего сброса
  const { rows } = await query(
    'SELECT last_reset_date FROM users WHERE id = $1',
    [userId]
  );
  if (!rows.length) return false;

  const lastReset = rows[0].last_reset_date; // может быть null
  const todayMsk = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
  
  let lastResetStr = null;
  if (lastReset) {
    lastResetStr = lastReset instanceof Date
      ? lastReset.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' })
      : new Date(lastReset).toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
  }

  // если ещё никогда не сбрасывали или дата < текущей даты по МСК — сбрасываем
  if (!lastResetStr || lastResetStr !== todayMsk) {
    await query(
      `UPDATE users
       SET downloads_today = 0,
           tracks_today = '[]'::jsonb,
           last_reset_date = $2::date
       WHERE id = $1`,
      [userId, todayMsk]
    );
    return true;
  }
  return false;
}
/* ========================= Пользователи / Премиум ========================= */
// === Тарифы и лимиты ===

// Админская функция выдачи/продления тарифа
// mode: 'set' — установить заново от NOW(); 'extend' — прибавить дни к текущей дате (если активна) или от NOW()
export async function setTariffAdmin(userId, limit, days, { mode = 'set', opType = 'adjustment', performedByType = 'system', performedByUserId = null, comment = null } = {}) {
  const freeLimitResult = await query(
    `SELECT COALESCE(
       (SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'),
       3
     )::int AS free_limit`
  );
  const freeLimit = Number(freeLimitResult.rows[0]?.free_limit ?? 3);

  // Получаем текущие данные пользователя перед обновлением
  const userQuery = await query(
    'SELECT premium_limit, premium_until FROM users WHERE id = $1',
    [userId]
  );
  
  let prevLimit = freeLimit;
  let prevPremiumUntil = null;
  
  if (userQuery.rowCount > 0) {
    prevLimit = userQuery.rows[0].premium_limit;
    prevPremiumUntil = userQuery.rows[0].premium_until;
  }
  
  const getPlanName = (lim, until) => {
    const isPrem = until && new Date(until) > new Date();
    if (!isPrem) return 'free';
    if (lim === null) return 'unlim';
    if (lim >= 100) return 'pro';
    return 'plus';
  };
  
  const prevPlan = getPlanName(prevLimit, prevPremiumUntil);
  const prevIsUnlim = (prevLimit === null && prevPremiumUntil && new Date(prevPremiumUntil) > new Date());

  // Определяем значение лимита для базы данных
  let dbLimit = null;
  if (limit !== null && limit !== undefined && limit !== 'unlim' && limit !== 'unlimited') {
    dbLimit = parseInt(limit, 10);
    if (!Number.isInteger(dbLimit) || dbLimit < 0) {
      throw new Error('Некорректный дневной лимит тарифа.');
    }
  }
  
  let sql;
  let params;
  
  if (dbLimit !== null && dbLimit <= freeLimit) {
    sql = `
      UPDATE users
      SET premium_limit = $2,
          premium_until = NULL,
          notified_about_expiration = FALSE,
          notified_exp_3d = FALSE,
          notified_exp_1d = FALSE,
          notified_exp_0d = FALSE
      WHERE id = $1
      RETURNING id, premium_limit, premium_until
    `;
    params = [userId, dbLimit];
  } else {
    sql = `
      UPDATE users
      SET premium_limit = $2,
          premium_until = CASE
            WHEN $4 = 'extend' THEN
              (CASE
                 WHEN premium_until IS NOT NULL AND premium_until > NOW()
                   THEN premium_until
                 ELSE NOW()
               END) + make_interval(days => $3::int)
            ELSE
              NOW() + make_interval(days => $3::int)
          END,
          notified_about_expiration = FALSE,
          notified_exp_3d = FALSE,
          notified_exp_1d = FALSE,
          notified_exp_0d = FALSE
      WHERE id = $1
      RETURNING id, premium_limit, premium_until
    `;
    params = [userId, dbLimit, Number(days), mode];
  }

  const { rows } = await query(sql, params);
  const updatedUser = rows[0];

  if (updatedUser) {
    const newPlan = getPlanName(updatedUser.premium_limit, updatedUser.premium_until);
    const newIsUnlim = (updatedUser.premium_limit === null && updatedUser.premium_until !== null);

    // Записываем нефинансовую операцию в базу
    try {
      await query(
        `INSERT INTO public.subscription_operations (
          user_id, payment_id, op_type,
          previous_plan, new_plan,
          previous_limit, new_limit,
          previous_premium_until, new_premium_until,
          previous_is_unlimited, new_is_unlimited,
          performed_by_type, performed_by_user_id,
          comment
         ) VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          userId, opType,
          prevPlan, newPlan,
          prevLimit, updatedUser.premium_limit,
          prevPremiumUntil, updatedUser.premium_until,
          prevIsUnlim, newIsUnlim,
          performedByType, performedByUserId,
          comment
        ]
      );
    } catch (e) {
      console.error('[DB] Ошибка логирования операции подписки:', e.message);
    }
  }

  return rows[0];
}

// Обратная совместимость: setPremium (используется бонусами, рефералами и т.д.)
// Всегда продлевает (extend) на days с указанным лимитом.
export async function setPremium(userId, limit, days = 30) {
  return setTariffAdmin(userId, Number(limit), Number(days), { mode: 'extend' });
}
export async function resetExpiredPremiumIfNeeded(userId) {
  const sql = `
    UPDATE users
    SET
      premium_limit = COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3),
      premium_until = NULL,
      notified_about_expiration = FALSE,
      notified_exp_3d = FALSE,
      notified_exp_1d = FALSE,
      notified_exp_0d = FALSE
    WHERE id = $1
      AND premium_until IS NOT NULL
      AND premium_until < NOW()
      AND (
        premium_limit IS NULL
        OR premium_limit <> COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3)
      )
    RETURNING id
  `;
  try {
    const { rows } = await query(sql, [userId]);
    if (rows?.length) {
      console.log(`[Premium/AutoReset] Пользователь ${userId} понижен до Free (истёк тариф).`);
    }
  } catch (e) {
    console.error('[DB] resetExpiredPremiumIfNeeded error:', e.message);
  }
}

export async function resetExpiredPremiumsBulk() {
  const sql = `
    UPDATE users
    SET
      premium_limit = COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3),
      premium_until = NULL,
      notified_about_expiration = FALSE,
      notified_exp_3d = FALSE,
      notified_exp_1d = FALSE,
      notified_exp_0d = FALSE
    WHERE premium_until IS NOT NULL
      AND premium_until < NOW()
      AND (
        premium_limit IS NULL
        OR premium_limit <> COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3)
      )
  `;
  try {
    const { rowCount } = await query(sql);
    if (rowCount) console.log(`[Premium/BulkReset] Понижено до Free: ${rowCount}`);
    return rowCount || 0;
  } catch (e) {
    console.error('[DB] resetExpiredPremiumsBulk error:', e.message);
    return 0;
  }
}
// db.js -- ДОБАВЬ ЭТУ ФУНКЦИЮ

/**
 * @description Сбрасывает дневную статистику (загрузки, треки) для всех пользователей.
 *              Вызывается раз в сутки фоновой задачей.
 */
export async function resetDailyStats() {
  console.log('[Cron] Запускаю ежедневный сброс статистики...');
  try {
    const { rowCount } = await pool.query(
      `UPDATE users
       SET downloads_today = 0,
           tracks_today = '[]'::jsonb,
           last_reset_date = CURRENT_DATE
       WHERE last_reset_date < CURRENT_DATE OR last_reset_date IS NULL`
    );
    console.log(`[Cron] Дневная статистика сброшена для ${rowCount} пользователей.`);
  } catch (error) {
    console.error('[Cron] Ошибка при ежедневном сбросе статистики:', error);
  }
}
export async function getReferrerInfo(userId) {
  const { rows } = await query(
    `SELECT r.id, r.first_name, r.username 
     FROM users u 
     JOIN users r ON u.referrer_id = r.id 
     WHERE u.id = $1`,
    [userId]
  );
  return rows[0] || null;
}

export async function getUserById(id) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function createUser(id, firstName, username, referrerId = null, referralSource = null, telegramLanguageCode = null) {
  // Нормализуем язык Telegram (импортируем inline чтобы не создавать цикличности)
  const { normalizeLanguageCode } = await import('./config/languages.js');
  const langCode = normalizeLanguageCode(telegramLanguageCode);
  const langSource = 'telegram_auto';

  const sql = `
    INSERT INTO users (
      id, first_name, username, referrer_id, referral_source,
      last_active, last_reset_date, premium_limit,
      telegram_language_code, language_code, language_source, language_updated_at
    )
    VALUES ($1, $2, $3, $4, $5, NOW(), CURRENT_DATE, 3, $6, $7, $8, NOW())
    ON CONFLICT (id) DO NOTHING
  `;
  const safeSource = referralSource ? referralSource.substring(0, 50) : null;
  await query(sql, [id, firstName, username, referrerId, safeSource, telegramLanguageCode || null, langCode, langSource]);
}

const userCache = new Map();
const USER_CACHE_TTL = 1500;

function cleanUserCache() {
  const now = Date.now();
  for (const [key, val] of userCache.entries()) {
    if (now - val.timestamp > USER_CACHE_TTL) {
      userCache.delete(key);
    }
  }
}

export async function getUser(id, firstName = '', username = '', startPayload = null, telegramLanguageCode = null) {
  const cacheKey = String(id);
  const now = Date.now();
  if (!startPayload && userCache.has(cacheKey)) {
    const cached = userCache.get(cacheKey);
    if (now - cached.timestamp < USER_CACHE_TTL) {
      return cached.data;
    }
  }

  const sqlSelect = `
    SELECT 
      *, 
      (SELECT COUNT(*) FROM users AS referrals WHERE referrals.referrer_id = u.id) AS referral_count 
    FROM users u WHERE u.id = $1
  `;
  const { rows } = await query(sqlSelect, [id]);

  if (rows.length > 0) {
    const user = rows[0];
    
    // Обновляем активность
    if (user.active) {
      await query('UPDATE users SET last_active = NOW() WHERE id = $1', [id]);
    }

    // Если пользователь перешел по рефке ПОЗЖЕ (и у него нет реферера), добавляем
    if (startPayload && startPayload.startsWith('ref_') && !user.referrer_id) {
      const parsedId = parseInt(startPayload.split('_')[1], 10);
      if (!isNaN(parsedId) && parsedId !== id) {
        try {
          await query('UPDATE users SET referrer_id = $1 WHERE id = $2 AND referrer_id IS NULL', [parsedId, id]);
          user.referrer_id = parsedId;
          console.log(`[Referral] Установлен referrer_id=${parsedId} для пользователя ${id}`);
        } catch (e) {
          console.error('[Referral] Ошибка обновления referrer_id:', e.message);
        }
      }
    }
    cleanUserCache();
    userCache.set(cacheKey, { timestamp: Date.now(), data: user });
    return user;
  } else {
    // === НОВЫЙ ПОЛЬЗОВАТЕЛЬ ===
    let referrerId = null;
    let referralSource = null;

    if (startPayload) {
        if (startPayload.startsWith('ref_')) {
             const parsedId = parseInt(startPayload.split('_')[1], 10);
             if (!isNaN(parsedId) && parsedId !== id) referrerId = parsedId;
        } else if (/^\d+$/.test(startPayload)) {
             // Старый формат рефок (просто цифры)
             const parsedId = parseInt(startPayload, 10);
             if (parsedId !== id) referrerId = parsedId;
        } else {
             // Если это текст (google, ad1, tiktok) - значит это ИСТОЧНИК
             referralSource = startPayload;
        }
    }

    // ВАЖНО: Передаем referralSource и язык Telegram в создание
    await createUser(id, firstName, username, referrerId, referralSource, telegramLanguageCode);
    
    const newUserResult = await query(sqlSelect, [id]);
    return newUserResult.rows[0];
  }
}
/* Поля разрешённые для updateUserField (Supabase update) */
const allowedFields = new Set([
  'premium_limit', 'downloads_today', 'total_downloads', 'first_name', 'username',
  'premium_until', 'subscribed_bonus_used', 'tracks_today', 'last_reset_date',
  'active', 'referred_count', 'promo_1plus1_used', 'has_reviewed',
  'notified_about_expiration',
  'notified_exp_3d', 'notified_exp_1d', 'notified_exp_0d',
  'can_receive_broadcasts', 'support_mode',
  'language_code', 'telegram_language_code', 'language_source', 'language_updated_at'
]);

export async function updateUserField(id, updates) {
  const fieldsToUpdate = (typeof updates === 'string')
    ? { [updates]: arguments[2] }
    : updates;

  const keys = Object.keys(fieldsToUpdate);
  if (keys.length === 0) return;

  for (const field of keys) {
    if (!allowedFields.has(field)) {
      throw new Error(`Недопустимое поле для обновления: ${field}`);
    }
  }

  const setClauses = keys.map((key, index) => `"${key}" = $${index + 2}`).join(', ');
  const values = keys.map(key => fieldsToUpdate[key]);
  
  const sql = `UPDATE users SET ${setClauses} WHERE id = $1`;
  try {
    await query(sql, [id, ...values]);
    userCache.delete(String(id));
  } catch (err) {
    console.error(`[DB] Ошибка при обновлении пользователя ${id} через SQL:`, err.message);
    throw new Error('Не удалось обновить пользователя.');
  }
}


export async function getAllUsers(includeInactive = true) {
  const sql = includeInactive
    ? 'SELECT * FROM users ORDER BY created_at DESC'
    : 'SELECT * FROM users WHERE active = TRUE ORDER BY created_at DESC';
  const { rows } = await query(sql);
  return rows;
}

export async function getPaginatedUsers(options) {
  let {
    searchQuery = '',
    statusFilter = '',
    page = 1,
    limit = 25,
    sortBy = 'created_at',
    sortOrder = 'desc',

    // расширенные фильтры
    tariff = '',
    premium = '',
    created_from = '',
    created_to = '',
    active_within_days = '',
    has_referrer = '',
    ref_source = '',
    downloads_min = ''
  } = options;

  // 1. Безопасная сортировка
  const allowedSortFields = [
    'id', 'total_downloads', 'created_at', 'last_active',
    'premium_limit', 'premium_until', 'active'
  ];
  const safeSortBy = allowedSortFields.includes(sortBy) ? `"${sortBy}"` : '"created_at"';
  const safeSortOrder = String(sortOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  page = Math.max(1, parseInt(page, 10) || 1);
  limit = Math.min(500, Math.max(1, parseInt(limit, 10) || 25));
  const offset = (page - 1) * limit;

  const whereClauses = [];
  const params = [];
  let i = 1;

  // 2. Фильтр по статусу (активен/заблокирован)
  if (statusFilter === 'active') whereClauses.push('active = TRUE');
  else if (statusFilter === 'inactive') whereClauses.push('active = FALSE');

  // 3. ПОИСК (Исправлен краш с .trim)
  if (searchQuery && typeof searchQuery === 'string') {
    let cleanQuery = searchQuery.trim();
    
    // Если ищем ID (число)
    if (/^\d+$/.test(cleanQuery)) {
        params.push(cleanQuery); // Для ID ищем точное совпадение или как строку
        whereClauses.push(`(CAST(id AS TEXT) = $${i} OR username ILIKE $${i} OR first_name ILIKE $${i})`);
    } else {
        // Если запрос начинается с @
        if (cleanQuery.startsWith('@')) {
            cleanQuery = cleanQuery.substring(1);
        }
        params.push(`%${cleanQuery}%`);
        whereClauses.push(`(username ILIKE $${i} OR first_name ILIKE $${i})`);
    }
    i++;
  }

 // 4. Тарифы: Free всегда берётся из app_settings, Unlimited хранится как NULL.
  if (tariff) {
    const now = "NOW()"; 

    if (tariff === 'Plus') {
      whereClauses.push(`premium_limit = COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_plus'), 30) AND premium_until > ${now}`);
    } 
    else if (tariff === 'Pro') {
      whereClauses.push(`premium_limit = COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_pro'), 100) AND premium_until > ${now}`);
    } 
    else if (tariff === 'Unlimited') {
      whereClauses.push(`(premium_limit >= COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_unlim'), 10000) OR premium_limit IS NULL) AND premium_until > ${now}`);
    } 
    else if (tariff === 'Free') {
      whereClauses.push(`(premium_limit <= COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3) OR premium_until IS NULL OR premium_until <= ${now})`);
    } 
    else if (tariff === 'Other') {
      whereClauses.push(`(premium_limit NOT IN (
        COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3),
        COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_plus'), 30),
        COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_pro'), 100),
        COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_unlim'), 10000)
      ) AND premium_limit IS NOT NULL AND premium_limit < 10000 AND premium_until > ${now})`);
    }
  }

  // 5. Состояние премиума (дублирует логику, но оставим для совместимости)
  if (premium) {
    if (premium === 'active') {
      whereClauses.push('premium_until > NOW()');
    } else if (premium === 'expired') {
      whereClauses.push('premium_until <= NOW()');
    } else if (premium === 'free') {
       whereClauses.push('(premium_until IS NULL OR premium_until <= NOW())');
    }
  }

  // Даты регистрации
  if (created_from) { params.push(created_from); whereClauses.push(`created_at::date >= $${i++}`); }
  if (created_to)   { params.push(created_to);   whereClauses.push(`created_at::date <= $${i++}`); }

  // Активность
  if (active_within_days) {
    params.push(Number(active_within_days) || 7);
    whereClauses.push(`last_active >= NOW() - ($${i++}::int * INTERVAL '1 day')`);
  }

  // Реферер
  if (has_referrer === 'yes') whereClauses.push('referrer_id IS NOT NULL');
  else if (has_referrer === 'no') whereClauses.push('referrer_id IS NULL');

  // Источник
  if (ref_source) {
    params.push(`%${ref_source}%`);
    whereClauses.push(`referral_source ILIKE $${i++}`);
  }

  // Скачивания
  if (downloads_min !== '' && downloads_min !== null && downloads_min !== undefined) {
    params.push(Number(downloads_min) || 0);
    whereClauses.push(`total_downloads >= $${i++}`);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  // 6. Считаем общее количество (для пагинации)
  const totalQuery = `SELECT COUNT(*) FROM users ${whereSql}`;
  // ВАЖНО: передаем params.slice, так как для count нужны те же параметры, что и для where, но без limit/offset
  // Но так как мы i++ делали динамически, параметры limit/offset добавляются позже.
  // Сейчас params содержит только WHERE параметры. Это ОК.
  
  const totalRes = await query(totalQuery, params);
  const totalUsers = parseInt(totalRes.rows[0].count, 10);
  const totalPages = Math.max(1, Math.ceil(totalUsers / limit));

  // 7. Получаем данные
  // Добавляем параметры пагинации в конец
  const paramsWithPaging = [...params, limit, offset];
  
  const usersQuery = `
    SELECT id, first_name, username, active,
           premium_limit, premium_until,
           total_downloads, created_at, last_active, referrer_id, referral_source
    FROM users
    ${whereSql}
    ORDER BY ${safeSortBy} ${safeSortOrder}
    LIMIT $${i} OFFSET $${i + 1} 
  `; 
  // i (limit) и i+1 (offset) - так как i мы инкрементировали выше, 
  // но тут мы создаем новый массив paramsWithPaging, поэтому индексы $ должны продолжать счет
  
  // В PostgreSQL node драйвере лучше использовать явные $1, $2... 
  // Но если у тебя функция query сама мапит параметры, то ок. 
  // Если нет, то indices для LIMIT и OFFSET должны быть: params.length + 1 и params.length + 2.
  
  const usersRes = await query(usersQuery, paramsWithPaging);

  return { users: usersRes.rows, totalPages, currentPage: page, totalUsers };
}
export async function getUsersAsCsv(options = {}) {
  let {
    searchQuery = '',
    statusFilter = '',

    // те же расширенные фильтры, что и в списке
    tariff = '',
    premium = '',
    created_from = '',
    created_to = '',
    active_within_days = '',
    has_referrer = '',
    ref_source = '',
    downloads_min = ''
  } = options;

  const whereClauses = [];
  const params = [];
  let i = 1;

  // статус
  if (statusFilter === 'active') whereClauses.push('active = TRUE');
  else if (statusFilter === 'inactive') whereClauses.push('active = FALSE');

  // поиск
  if (searchQuery) {
    params.push(`%${searchQuery}%`);
    whereClauses.push(`(CAST(id AS TEXT) ILIKE $${i} OR first_name ILIKE $${i} OR username ILIKE $${i})`);
    i++;
  }

  // тариф
  if (tariff) {
    if (tariff === 'Free') whereClauses.push(`(premium_limit <= COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3) OR premium_until IS NULL OR premium_until < NOW())`);
    else if (tariff === 'Plus') whereClauses.push(`premium_limit = COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_plus'), 30) AND premium_until >= NOW()`);
    else if (tariff === 'Pro') whereClauses.push(`premium_limit = COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_pro'), 100) AND premium_until >= NOW()`);
    else if (tariff === 'Unlimited') whereClauses.push(`(premium_limit >= COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_unlim'), 10000) OR premium_limit IS NULL) AND premium_until >= NOW()`);
    else if (tariff === 'Other') {
      whereClauses.push(`(
        premium_limit NOT IN (
          COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3),
          COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_plus'), 30),
          COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_pro'), 100),
          COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_unlim'), 10000)
        )
        AND premium_limit IS NOT NULL
        AND premium_limit < 10000
      )`);
    }
  }

  // состояние премиума
  if (premium) {
    if (premium === 'active') {
      whereClauses.push(`(premium_limit > COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3) OR premium_limit IS NULL) AND premium_until >= NOW()`);
    } else if (premium === 'expired') {
      whereClauses.push(`(premium_limit > COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3) OR premium_limit IS NULL) AND premium_until IS NOT NULL AND premium_until < NOW()`);
    } else if (premium === 'free') {
      whereClauses.push(`(premium_limit <= COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3) OR premium_until IS NULL OR premium_until < NOW())`);
    }
  }

  // даты регистрации
  if (created_from) { params.push(created_from); whereClauses.push(`created_at::date >= $${i++}`); }
  if (created_to)   { params.push(created_to);   whereClauses.push(`created_at::date <= $${i++}`); }

  // активность за N дней
  if (active_within_days) {
    params.push(Number(active_within_days) || 7);
    whereClauses.push(`last_active >= NOW() - ($${i++}::int * INTERVAL '1 day')`);
  }

  // реферер
  if (has_referrer === 'yes') whereClauses.push('referrer_id IS NOT NULL');
  else if (has_referrer === 'no') whereClauses.push('referrer_id IS NULL');

  // источник
  if (ref_source) {
    params.push(`%${ref_source}%`);
    whereClauses.push(`referral_source ILIKE $${i++}`);
  }

  // скачивания
  if (downloads_min !== '' && downloads_min !== null && downloads_min !== undefined) {
    params.push(Number(downloads_min) || 0);
    whereClauses.push(`total_downloads >= $${i++}`);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT id, first_name, username, active,
            total_downloads, premium_limit, premium_until,
            created_at, last_active
     FROM users
     ${whereSql}
     ORDER BY created_at DESC`,
    params
  );

  const headers = 'ID,FirstName,Username,Status,TotalDownloads,PremiumLimit,PremiumUntil,CreatedAt,LastActive\n';
  const csvRows = rows.map(u => [
    u.id,
    escapeCsv(u.first_name),
    escapeCsv(u.username),
    u.active ? 'active' : 'inactive',
    u.total_downloads || 0,
    u.premium_limit || 0,
    u.premium_until ? new Date(u.premium_until).toISOString() : '',
    new Date(u.created_at).toISOString(),
    u.last_active ? new Date(u.last_active).toISOString() : ''
  ].join(','));

  return headers + csvRows.join('\n');
}
// ==================================================================
// ==================================================================
// НЕЧЕТКИЙ ПОИСК (Fuzzy Search с pg_trgm)
// ==================================================================
export async function searchTracksInCache(searchQuery, limit = 7) {
  // 1. Объявляем переменную ЗДЕСЬ, чтобы она была видна и в try, и в catch
  const cleanQuery = searchQuery ? searchQuery.trim() : '';
  if (!cleanQuery) return [];

  try {
    // Сначала пробуем RPC (если вы его настроили)
    const { data, error } = await supabase.rpc('search_tracks', { search_query: cleanQuery, result_limit: limit });
    
    if (!error && data && data.length > 0) {
      return data;
    }
    
    // FALLBACK: Умный нечеткий поиск (Trigram Similarity)
    // Теперь это будет работать, так как вы включили расширение pg_trgm
    console.log(`[DB Search] Пробую Trigram Similarity для: "${cleanQuery}"`);
    
    const sql = `
      SELECT file_id, title, artist, duration, url
      FROM track_cache
      WHERE 
        title ILIKE $1 OR artist ILIKE $1
        OR (title <-> $2) < 0.8
      ORDER BY (title <-> $2) ASC
      LIMIT $3
    `;
    
    const likeQuery = `%${cleanQuery}%`;
    
    // Исправил порядок аргументов, чтобы совпадал с SQL ($1, $2, $3)
    const { rows } = await query(sql, [likeQuery, cleanQuery, limit]);
    
    if (rows.length > 0) {
      console.log(`[DB Search] Найдено ${rows.length} треков.`);
      return rows;
    }
    
    return [];
    
  } catch (e) {
    // Если база данных все равно выдаст ошибку (например, расширение слетит)
    // Код перейдет сюда. И теперь cleanQuery ЗДЕСЬ ВИДНА.
    
    if (e.message.includes('operator does not exist') && e.message.includes('<->')) {
      console.warn('[DB Search] Расширение pg_trgm не работает! Откатываюсь на ILIKE.');
      // Fallback на безопасный ILIKE
      const safeSql = `SELECT file_id, title, artist, duration, url FROM track_cache WHERE title ILIKE $1 OR artist ILIKE $1 LIMIT $2`;
      const { rows } = await query(safeSql, [`%${cleanQuery}%`, limit]);
      return rows;
    }
    
    console.error('[DB Search] Ошибка при поиске:', e.message);
    return [];
  }
}
// ========================================
// СОХРАНЕНИЕ ТРЕКА В КЭШ
// ========================================
/**
 * Сохраняет трек в кэш
 */
export async function cacheTrack({ 
  url, 
  fileId, 
  title, 
  artist, 
  duration, 
  thumbnail,
  source = 'soundcloud',
  quality = 'high',
  spotifyId = null,
  isrc = null,
  aliases = []
}) {
  try {
    // SQL Upsert
    const sql = `
      INSERT INTO track_cache (
        url, file_id, title, artist, duration, thumbnail, 
        source, quality, spotify_id, isrc, cached_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      ON CONFLICT (url) DO UPDATE SET
        file_id = EXCLUDED.file_id,
        title = EXCLUDED.title,
        cached_at = NOW()
    `;
    
    await query(sql, [url, fileId, title, artist, duration, thumbnail, source, quality, spotifyId, isrc]);

    // Алиасы (если есть) — bulk INSERT
    if (aliases && aliases.length > 0) {
      const placeholders = [];
      const values = [];
      let idx = 1;
      for (const aliasUrl of aliases) {
        placeholders.push(`($${idx}, $${idx+1}, $${idx+2}, $${idx+3}, $${idx+4}, $${idx+5}, $${idx+6}, NOW())`);
        values.push(aliasUrl, fileId, title, artist, duration, source, quality);
        idx += 7;
      }
      await query(
        `INSERT INTO track_cache (url, file_id, title, artist, duration, source, quality, cached_at)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (url) DO NOTHING`,
        values
      );
      console.log(`[Cache] Сохранено ${aliases.length} алиасов для: ${title}`);
    }

    console.log(`[✓ Cache Saved (SQL)] ${title} - ${artist} (${source}/${quality})`);
    return true;

  } catch (e) {
    console.error('[Cache] Ошибка сохранения (SQL):', e.message);
    return false;
  }
}

/**
 * Ищет трек в кэше (с учётом качества для Spotify)
 */
/**
 * Ищет трек в кэше (переписано на прямые SQL-запросы для надежности и скорости)
 */
/**
 * Ищет трек в кэше (Комбинированный метод: быстрый SQL для точных совпадений + RPC для нечетких)
 */
export async function findCachedTrack(key, options = {}) {
  const { source, quality } = options;
  
  try {
    // 1. Прямой поиск по ключу (Быстрый SQL)
    const exactSql = `SELECT * FROM track_cache WHERE url = $1 LIMIT 1`;
    const { rows: exactRows } = await query(exactSql, [key]);

    if (exactRows.length > 0) {
      const data = exactRows[0];
      console.log(`[✓ Cache HIT] ${data.title} (прямое совпадение)`);
      return { fileId: data.file_id, ...data };
    }

    // 2. Поиск по Spotify ID (Быстрый SQL)
    if (key.includes('spotify.com/track/')) {
      const spotifyId = key.match(/track\/([a-zA-Z0-9]+)/)?.[1];
      if (spotifyId && quality) {
        const spotSql = `SELECT * FROM track_cache WHERE spotify_id = $1 AND quality = $2 LIMIT 1`;
        const { rows: spotRows } = await query(spotSql, [spotifyId, quality]);

        if (spotRows.length > 0) {
          const spotifyData = spotRows[0];
          console.log(`[✓ Cache HIT] ${spotifyData.title} (spotify_id + quality)`);
          return { fileId: spotifyData.file_id, ...spotifyData };
        }
      }
    }

    // 3. Нечёткий поиск 
    // ВОЗВРАЩАЕМ ВЫЗОВ ЧЕРЕЗ SUPABASE, чтобы избежать ошибки с типами (unknown)
    const { data: similarData, error: rpcError } = await supabase
      .rpc('find_similar_track', { search_key: key });

    if (!rpcError && similarData && similarData.length > 0) {
      const match = similarData[0];
      console.log(`[✓ Cache HIT] ${match.title} (похожее совпадение)`);
      return { fileId: match.file_id, ...match };
    }

    console.log(`[✗ Cache MISS] ${key.slice(0, 50)}...`);
    return null;

  } catch (e) {
    console.error('[Cache] Ошибка поиска:', e.message);
    return null;
  }
}
// ========================================
// ПОИСК ПО МЕТАДАННЫМ (title, artist, duration)
// ========================================
export async function findCachedTrackByMeta({ title, artist, duration }) {
    try {
        // Проверяем наличие данных
        if (!title || !artist || !duration) {
            console.log('[⚠ Cache] Недостаточно метаданных для поиска');
            return null;
        }
        
        const roundedDuration = Math.round(duration);
        
        // ✅ ИСПРАВЛЕНО: sqlQuery вместо query
        const sqlQuery = `
      SELECT file_id, title, artist, url, duration
      FROM track_cache
      WHERE 
        title ILIKE $1 AND 
        artist ILIKE $2 AND
        duration BETWEEN $3 AND $4
      LIMIT 1
    `;
        
        const { rows } = await query(
            sqlQuery,
            [title, artist, roundedDuration - 2, roundedDuration + 2]
        );
        
        if (rows.length > 0) {
            console.log(`[✓ Cache HIT by Meta] ${rows[0].title} - ${rows[0].artist}`);
            return {
                fileId: rows[0].file_id,
                title: rows[0].title,
                artist: rows[0].artist,
                url: rows[0].url
            };
        }
        
        console.log(`[✗ Cache MISS] ${title} - ${artist} (${roundedDuration}s)`);
        return null;
        
    } catch (e) {
        console.error('[DB Error] findCachedTrackByMeta:', e.message);
        return null;
    }
}
export async function getCachedTracksCount() {
  try {
    const { rows } = await query('SELECT COUNT(*) FROM track_cache');
    return parseInt(rows[0].count, 10);
  } catch (e) {
    console.error('Ошибка при подсчете кэшированных треков:', e.message);
    return 0;
  }
}

/**
 * Статистика кэша по источникам
 */
export async function getCacheStats() {
  try {
    const { data, error } = await supabase
      .rpc('get_cache_stats');

    if (error) throw error;
    return data;
  } catch (e) {
    console.error('[Cache] Ошибка получения статистики:', e.message);
    return null;
  }
}

/* ========================= Логирование ========================= */

export async function incrementDownloadsAndSaveTrack(userId, trackName, fileId, url, source = null, isCacheHit = false) {
  const newTrack = { title: trackName, fileId, url };
  const res = await query(
    `UPDATE users
     SET downloads_today  = downloads_today + 1,
         total_downloads  = total_downloads + 1,
         downloads_count  = COALESCE(downloads_count, 0) + 1,
         yandex_promo_progress = COALESCE(yandex_promo_progress, 0) + 1,
         tracks_today     = COALESCE(tracks_today, '[]'::jsonb) || $1::jsonb
     WHERE id = $2
       AND (
         (premium_until IS NOT NULL AND premium_until >= NOW() AND premium_limit IS NULL)
         OR downloads_today < CASE
           WHEN premium_until IS NOT NULL AND premium_until >= NOW()
             THEN premium_limit
           ELSE COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3)
         END
       )
     RETURNING *`,
    [newTrack, userId]
  );
  if (res.rowCount > 0) {
    const updatedUser = res.rows[0];
    await logDownload(userId, trackName, url, source, isCacheHit);

    // Проверяем, достиг ли пользователь дневного лимита
    const isPremium = updatedUser.premium_until && new Date(updatedUser.premium_until) > new Date();
    const { getSetting } = await import('./services/settingsManager.js');
    const freeLimit = parseInt(getSetting('daily_limit_free') || '3', 10);
    const userLimit = isPremium ? updatedUser.premium_limit : freeLimit;
    if (userLimit !== null && updatedUser.downloads_today === userLimit) {
      try {
        const { analyticsService } = await import('./services/analyticsService.js');
        await analyticsService.trackEventSafe(userId, 'daily_limit_reached', 'limits', {
          limit: userLimit,
          downloads_today: updatedUser.downloads_today
        });
      } catch (ae) {
        console.error('[Analytics] Error tracking daily_limit_reached:', ae.message);
      }
    }

    // Инкрементируем прогресс для всех активных кастомных РК
    try {
      await query(
        `INSERT INTO user_promo_progress (user_id, campaign_id, progress, shown)
         SELECT $1, id, 1, false FROM promo_campaigns
         WHERE id > 2 AND is_active = true
         ON CONFLICT (user_id, campaign_id) DO UPDATE
         SET progress = user_promo_progress.progress + 1
         WHERE user_promo_progress.shown = false`,
        [userId]
      );
    } catch (e) {
      console.error('[DB] Ошибка инкремента кастомных промо:', e.message);
    }
  }
  return res.rowCount > 0 ? res.rows[0] : null;
}

// db.js

/**
 * Логирует загрузку трека в историю (Использует SQL для обхода RLS)
 */
// =========================================================
// ИСПРАВЛЕННАЯ ФУНКЦИЯ (SQL вместо Supabase Client)
// =========================================================
export async function logDownload(userId, trackTitle, url, source = null, isCacheHit = false) {
  try {
    // Определяем источник, если он не передан
    let detectedSource = source;
    if (!detectedSource) {
      if (url?.includes('soundcloud.com')) detectedSource = 'soundcloud';
      else if (url?.includes('spotify.com') || url?.includes('spotify:')) detectedSource = 'spotify';
      else if (url?.includes('youtube.com') || url?.includes('youtu.be') || url?.startsWith('ytsearch')) detectedSource = 'youtube';
      else detectedSource = 'other';
    }

    const dlRes = await query(
      `INSERT INTO downloads_log (user_id, track_title, url, source, downloaded_at)
       VALUES ($1, $2, $3, $4, timezone('utc', now()))
       RETURNING id`,
      [userId, trackTitle, url, detectedSource]
    );

    const downloadLogId = dlRes.rowCount > 0 ? dlRes.rows[0].id : null;
    console.log(`[DownloadLog] ✅ Запись (SQL): user=${userId}, source=${detectedSource}, id=${downloadLogId}`);

    // Логируем аналитическое событие
    try {
      const { analyticsService } = await import('./services/analyticsService.js');
      const dedupKey = downloadLogId ? `download_log:${downloadLogId}` : null;
      await analyticsService.trackEventSafe(userId, 'track_download_success', 'downloads', {
        title: trackTitle,
        url,
        source: detectedSource,
        delivery_source: isCacheHit ? 'cache' : 'download',
        download_log_id: downloadLogId,
        deduplication_key: dedupKey
      });
    } catch (ae) {
      console.error('[Analytics] Error tracking download success:', ae.message);
    }
    
    return downloadLogId;
  } catch (e) {
    console.error('❌ Ошибка записи logDownload (SQL):', e.message);
    return null;
  }
}

/**
 * Атомарно помечает промо как показанное для конкретного юзера.
 * Срабатывает только один раз (WHERE yandex_promo_shown = false).
 */
export async function markYandexPromoShown(userId) {
  const res = await query(
    `UPDATE users SET yandex_promo_shown = true
     WHERE id = $1 AND COALESCE(yandex_promo_shown, false) = false
     RETURNING id`,
    [userId]
  );
  return res.rowCount > 0;
}

export async function logEvent(userId, event) {
  try {
    await query(
      'INSERT INTO events (user_id, event_type) VALUES ($1, $2)',
      [userId, event]
    );
  } catch (e) {
    console.error('❌ Ошибка при logEvent:', e.message);
  }
}

export async function logUserAction(userId, actionType, details = null) {
  try {
    await query(
      'INSERT INTO user_actions_log (user_id, action_type, details) VALUES ($1, $2, $3)',
      [userId, actionType, details ? JSON.stringify(details) : null]
    );
  } catch (e) {
    console.error(`❌ Ошибка логирования действия для пользователя ${userId}:`, e.message);
  }
}

export async function getUserActions(userId, limit = 20) {
  try {
    const { rows } = await query(
      'SELECT * FROM user_actions_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
      [userId, limit]
    );
    return rows;
  } catch (e) {
    console.error(`❌ Ошибка получения лога действий для ${userId}:`, e.message);
    return [];
  }
}

/* ========================= Статистика / Дашборд ========================= */

export async function getReferralSourcesStats() {
  const { rows } = await query(
    `SELECT referral_source, COUNT(*) as count
     FROM users
     WHERE referral_source IS NOT NULL
     GROUP BY referral_source
     ORDER BY count DESC`
  );
  return rows.map(row => ({ source: row.referral_source, count: parseInt(row.count, 10) }));
}

export async function getRegistrationsByDate() {
  const { rows } = await query(
    `SELECT TO_CHAR(created_at, 'YYYY-MM-DD') as date, COUNT(*) as count
     FROM users
     GROUP BY date
     ORDER BY date`
  );
  return rows.reduce((acc, row) => ({ ...acc, [row.date]: parseInt(row.count, 10) }), {});
}

export async function getDownloadsByDate() {
  const { rows } = await query(
    `SELECT TO_CHAR(downloaded_at, 'YYYY-MM-DD') as date, COUNT(*) as count
     FROM downloads_log
     GROUP BY date
     ORDER BY date`
  );
  return rows.reduce((acc, row) => ({ ...acc, [row.date]: parseInt(row.count, 10) }), {});
}

export async function getActiveUsersByDate() {
  const { rows } = await query(
    `SELECT TO_CHAR(last_active, 'YYYY-MM-DD') as date, COUNT(DISTINCT id) as count
     FROM users
     WHERE last_active IS NOT NULL
     GROUP BY date
     ORDER BY date`
  );
  return rows.reduce((acc, row) => ({ ...acc, [row.date]: parseInt(row.count, 10) }), {});
}

// =================================================================
// ЗАМЕНИТЬ СУЩЕСТВУЮЩУЮ ФУНКЦИЮ getDownloadsByUserId В db.js
// =================================================================
export async function getDownloadsByUserId(userId, limit = 50) {
  const { rows } = await query(
    `SELECT track_title, downloaded_at, url 
     FROM downloads_log
     WHERE user_id = $1
     ORDER BY downloaded_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

export async function getReferralsByUserId(userId) {
  const { rows } = await query(
    `SELECT id, first_name, username, created_at
     FROM users
     WHERE referrer_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

export async function getUsersCountByTariff() {
  const { rows } = await query(`
    SELECT CASE 
        WHEN premium_until IS NOT NULL AND premium_until >= NOW() THEN
          CASE 
            WHEN premium_limit = COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_plus'), 30) THEN 'Plus'
            WHEN premium_limit = COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_pro'), 100) THEN 'Pro'
            WHEN premium_limit >= COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_unlim'), 10000) OR premium_limit IS NULL THEN 'Unlimited'
            ELSE 'Other'
          END
        ELSE 'Free'
      END as tariff,
      COUNT(id) as count
    FROM users
    WHERE active = TRUE
    GROUP BY tariff
  `);
  const result = { Free: 0, Plus: 0, Pro: 0, Unlimited: 0, Other: 0 };
  rows.forEach(row => { result[row.tariff] = parseInt(row.count, 10); });
  return result;
}

export async function getTopReferralSources(limit = 5) {
  const { rows } = await query(
    `SELECT referral_source, COUNT(id) as count
     FROM users
     WHERE referral_source IS NOT NULL AND referral_source != ''
     GROUP BY referral_source
     ORDER BY count DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function getDailyStats(options = {}) {
  const endDate = options.endDate ? new Date(options.endDate) : new Date();
  const startDate = options.startDate ? new Date(options.startDate) : new Date(new Date().setDate(endDate.getDate() - 29));
  const startDateSql = startDate.toISOString().slice(0, 10);
  const endDateSql = endDate.toISOString().slice(0, 10);
  
  try {
    const { rows } = await query(`
    WITH date_series AS (
      SELECT generate_series($1::date, $2::date, '1 day')::date AS day
    ),
    daily_registrations AS (
      SELECT created_at::date AS day, COUNT(id) AS registrations
      FROM users
      WHERE created_at::date BETWEEN $1 AND $2
      GROUP BY created_at::date
    ),
    daily_activity AS (
      SELECT downloaded_at::date AS day, COUNT(id) AS downloads, COUNT(DISTINCT user_id) AS active_users
      FROM downloads_log
      WHERE downloaded_at IS NOT NULL 
        AND downloaded_at::date BETWEEN $1 AND $2
      GROUP BY downloaded_at::date
    ),
    daily_by_source AS (
      SELECT 
        downloaded_at::date AS day,
        COALESCE(NULLIF(source, ''), 'other') AS source,
        COUNT(id) AS downloads
      FROM downloads_log
      WHERE downloaded_at IS NOT NULL 
        AND downloaded_at::date BETWEEN $1 AND $2
      GROUP BY downloaded_at::date, COALESCE(NULLIF(source, ''), 'other')
    )
    SELECT 
      to_char(ds.day, 'YYYY-MM-DD') as day,
      COALESCE(dr.registrations, 0)::int AS registrations,
      COALESCE(da.active_users, 0)::int AS active_users,
      COALESCE(da.downloads, 0)::int AS downloads,
      COALESCE(
        (
          SELECT json_object_agg(source, downloads)
          FROM daily_by_source dbs2
          WHERE dbs2.day = ds.day
        ),
        '{}'::json
      ) AS downloads_by_source
    FROM date_series ds
    LEFT JOIN daily_registrations dr ON ds.day = dr.day
    LEFT JOIN daily_activity da ON ds.day = da.day
    GROUP BY ds.day, dr.registrations, da.active_users, da.downloads
    ORDER BY ds.day
  `, [startDateSql, endDateSql]);
    return rows;
  } catch (e) {
    console.error('[DB] Ошибка getDailyStats (возможно поле source не существует):', e.message);
    // Fallback: возвращаем данные без разбивки по источникам
    try {
      const { rows } = await query(`
        WITH date_series AS (
          SELECT generate_series($1::date, $2::date, '1 day')::date AS day
        ),
        daily_registrations AS (
          SELECT created_at::date AS day, COUNT(id) AS registrations
          FROM users
          WHERE created_at::date BETWEEN $1 AND $2
          GROUP BY created_at::date
        ),
        daily_activity AS (
          SELECT downloaded_at::date AS day, COUNT(id) AS downloads, COUNT(DISTINCT user_id) AS active_users
          FROM downloads_log
          WHERE downloaded_at IS NOT NULL 
            AND downloaded_at::date BETWEEN $1 AND $2
          GROUP BY downloaded_at::date
        )
        SELECT 
          to_char(ds.day, 'YYYY-MM-DD') as day,
          COALESCE(dr.registrations, 0)::int AS registrations,
          COALESCE(da.active_users, 0)::int AS active_users,
          COALESCE(da.downloads, 0)::int AS downloads,
          '{}'::json AS downloads_by_source
        FROM date_series ds
        LEFT JOIN daily_registrations dr ON ds.day = dr.day
        LEFT JOIN daily_activity da ON ds.day = da.day
        ORDER BY ds.day
      `, [startDateSql, endDateSql]);
      return rows;
    } catch (e2) {
      console.error('[DB] Критическая ошибка getDailyStats:', e2.message);
      return [];
    }
  }
}

// В db.js

export async function getActivityByWeekday(startDate, endDate) {
  // Берем даты из аргументов или ставим дефолт (30 дней)
  const end = endDate ? new Date(endDate) : new Date();
  const start = startDate ? new Date(startDate) : new Date(new Date().setDate(end.getDate() - 30));

  const { rows } = await query(
    `SELECT EXTRACT(ISODOW FROM downloaded_at) as weekday_num, COUNT(DISTINCT user_id) as count
     FROM downloads_log
     WHERE downloaded_at >= $1 AND downloaded_at <= $2
     GROUP BY 1
     ORDER BY 1`,
    [start, end]
  );
  
  const weekdays = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
  const result = Array(7).fill(0).map((_, i) => ({ weekday: weekdays[i], count: 0 }));
  
  rows.forEach(row => { 
      const idx = parseInt(row.weekday_num, 10) - 1;
      if (result[idx]) result[idx].count = parseInt(row.count, 10); 
  });
  return result;
}

export async function getHourlyActivity(startDate, endDate) {
  const end = endDate ? new Date(endDate) : new Date();
  const start = startDate ? new Date(startDate) : new Date(new Date().setDate(end.getDate() - 7));

  const { rows } = await query(
    `SELECT EXTRACT(HOUR FROM downloaded_at AT TIME ZONE 'UTC') as hour, COUNT(*) as count
     FROM downloads_log
     WHERE downloaded_at >= $1 AND downloaded_at <= $2
     GROUP BY hour
     ORDER BY hour`,
    [start, end]
  );
  
  const hourlyCounts = Array(24).fill(0);
  rows.forEach(row => { hourlyCounts[parseInt(row.hour, 10)] = parseInt(row.count, 10); });
  return hourlyCounts;
}

export async function getTopTracks(limit = 10) {
  const { rows } = await query(
    `SELECT track_title, COUNT(*) as count
     FROM downloads_log
     GROUP BY track_title
     ORDER BY count DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function getTopUsers(limit = 15) {
  const { rows } = await query(
    `SELECT id, first_name, username, total_downloads
     FROM users
     WHERE total_downloads > 0
     ORDER BY total_downloads DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function getUsersTotalsSnapshot() {
  const { rows } = await query(`
    SELECT
      COUNT(*)::int AS total_users,
      COUNT(*) FILTER (WHERE active = TRUE)::int AS active_users,
      COALESCE(SUM(total_downloads), 0)::bigint AS total_downloads,
      COUNT(*) FILTER (WHERE last_active::date = CURRENT_DATE)::int AS active_today
    FROM users
  `);
  return rows[0];
}
export { getUsersTotalsSnapshot as getDashboardCounters };

/* ========================= Рассылки ========================= */

export async function deleteBroadcastTask(taskId) {
  await query(`DELETE FROM broadcast_tasks WHERE id = $1 AND status = 'pending'`, [taskId]);
}

export async function getBroadcastTaskById(taskId) {
  const { rows } = await query(`SELECT * FROM broadcast_tasks WHERE id = $1`, [taskId]);
  return rows[0] || null;
}

export async function createBroadcastTask(taskData) {
  const {
    message, file_id, file_mime_type, keyboard,
    disable_web_page_preview, targetAudience, scheduledAt, disableNotification,
    target_languages, unknown_language_policy, messages_json, language_source_filter,
    broadcast_type, campaign_name, campaign_tag, fallback_language,
    launch_confirmed_at, launch_confirmed_by
  } = taskData;
  if (!launch_confirmed_at || launch_confirmed_by === null || launch_confirmed_by === undefined) {
    const error = new Error('Broadcast launch confirmation is required.');
    error.code = 'BROADCAST_LAUNCH_CONFIRMATION_REQUIRED';
    throw error;
  }
  const queryText = `
    INSERT INTO broadcast_tasks (
      message, file_id, file_mime_type, keyboard,
      disable_web_page_preview, target_audience, status, scheduled_at, disable_notification,
      target_languages, unknown_language_policy, messages_json, language_source_filter,
      broadcast_type, campaign_name, campaign_tag, fallback_language,
      launch_confirmed_at, launch_confirmed_by
    ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
    RETURNING *;
  `;
  const values = [
    message || null, file_id || null, file_mime_type || null, keyboard ? JSON.stringify(keyboard) : null,
    !!disable_web_page_preview, targetAudience || 'all', scheduledAt || new Date(), !!disableNotification,
    target_languages || ['all'], unknown_language_policy || 'use_ru', messages_json ? JSON.stringify(messages_json) : null, language_source_filter || 'all',
    broadcast_type || 'marketing', campaign_name || null, campaign_tag || null, fallback_language || 'ru',
    launch_confirmed_at, launch_confirmed_by
  ];
  const result = await query(queryText, values);
  return result.rows[0];
}

export async function updateBroadcastTask(id, taskData) {
  const {
    message, file_id, file_mime_type, keyboard,
    disable_web_page_preview, targetAudience, scheduledAt, disableNotification,
    target_languages, unknown_language_policy, messages_json, language_source_filter,
    broadcast_type, campaign_name, campaign_tag, fallback_language,
    launch_confirmed_at, launch_confirmed_by
  } = taskData;
  if (!launch_confirmed_at || launch_confirmed_by === null || launch_confirmed_by === undefined) {
    const error = new Error('Broadcast launch confirmation is required.');
    error.code = 'BROADCAST_LAUNCH_CONFIRMATION_REQUIRED';
    throw error;
  }
  const queryText = `
    UPDATE broadcast_tasks SET
      message = $1,
      file_id = $2,
      file_mime_type = $3,
      keyboard = $4,
      disable_web_page_preview = $5,
      target_audience = $6,
      scheduled_at = $7,
      disable_notification = $8,
      target_languages = $9,
      unknown_language_policy = $10,
      messages_json = $11,
      language_source_filter = $12,
      broadcast_type = $13,
      campaign_name = $14,
      campaign_tag = $15,
      fallback_language = $16,
      launch_confirmed_at = $17,
      launch_confirmed_by = $18,
      status = 'pending'
    WHERE id = $19 AND status = 'pending'
    RETURNING *;
  `;
  const values = [
    message || null, file_id || null, file_mime_type || null, keyboard ? JSON.stringify(keyboard) : null,
    !!disable_web_page_preview, targetAudience || 'all', scheduledAt || new Date(), !!disableNotification,
    target_languages || ['all'], unknown_language_policy || 'use_ru', messages_json ? JSON.stringify(messages_json) : null, language_source_filter || 'all',
    broadcast_type || 'marketing', campaign_name || null, campaign_tag || null, fallback_language || 'ru',
    launch_confirmed_at, launch_confirmed_by, id
  ];
  const result = await query(queryText, values);
  return result.rows[0];
}

export async function getAndStartPendingBroadcastTask() {
  const sql = `
    UPDATE broadcast_tasks
    SET status = 'processing', started_at = NOW()
    WHERE id = (
      SELECT id FROM broadcast_tasks
      WHERE status = 'pending'
        AND launch_confirmed_at IS NOT NULL
        AND scheduled_at <= NOW()
        AND COALESCE(
          (SELECT value::boolean FROM app_settings WHERE key = 'broadcasts_enabled'),
          FALSE
        ) = TRUE
      ORDER BY scheduled_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
  `;
  const { rows } = await query(sql);
  return rows[0] || null;
}

export async function areBroadcastsEnabled() {
  const { rows } = await query(
    `SELECT COALESCE(
       (SELECT value::boolean FROM app_settings WHERE key = 'broadcasts_enabled'),
       FALSE
     ) AS enabled`
  );
  return rows[0]?.enabled === true;
}

export async function setBroadcastsEnabled(enabled) {
  await setAppSetting('broadcasts_enabled', enabled ? 'true' : 'false');
  return Boolean(enabled);
}

export async function getBroadcastExecutionState(taskId) {
  const { rows } = await query(
    `SELECT t.status,
            t.launch_confirmed_at IS NOT NULL AS launch_confirmed,
            COALESCE(
              (SELECT value::boolean FROM app_settings WHERE key = 'broadcasts_enabled'),
              FALSE
            ) AS broadcasts_enabled
     FROM broadcast_tasks t
     WHERE t.id = $1`,
    [taskId]
  );
  return rows[0] || null;
}

export async function cancelBroadcastTask(taskId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const taskResult = await client.query(
      `UPDATE broadcast_tasks
       SET status = 'cancelled', completed_at = NOW()
       WHERE id = $1 AND status IN ('pending', 'processing')
       RETURNING id, status`,
      [taskId]
    );
    if (!taskResult.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const logResult = await client.query(
      `UPDATE broadcast_log
       SET status = 'cancelled'
       WHERE broadcast_id = $1 AND status = 'pending'`,
      [taskId]
    );
    await client.query('COMMIT');
    return { id: taskResult.rows[0].id, cancelledRecipients: logResult.rowCount || 0 };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function getSqlLanguageSegmentExpr() {
  const langRegex = /^[a-z]{2,5}$/;
  const supportedTgPrefixes = ['ru', 'uk', 'be', 'kk', 'en'];

  let whenClauses = [];

  for (const lang of SUPPORTED_LANGUAGES) {
    if (!langRegex.test(lang)) {
      throw new Error(`[Security Alert] Недопустимый формат кода языка: ${lang}`);
    }

    // 1. user_selected / admin_changed / legacy_default → доверяем language_code напрямую
    whenClauses.push(`
      WHEN language_source IN ('user_selected', 'admin_changed', 'legacy_default')
           AND language_code = '${lang}'
      THEN '${lang}'
    `);

    // 2. telegram_auto → доверяем только если telegram_language_code из поддерживаемой группы
    const tgLikeClauses = supportedTgPrefixes.map(p => `telegram_language_code ILIKE '${p}%'`).join(' OR ');
    whenClauses.push(`
      WHEN language_source = 'telegram_auto'
           AND language_code = '${lang}'
           AND (telegram_language_code IS NULL OR (${tgLikeClauses}))
      THEN '${lang}'
    `);
  }

  return `CASE ${whenClauses.join(' ')} ELSE 'unknown' END`;
}

export function buildBroadcastAudienceQuery(targetAudience, targetLanguages, unknownLanguagePolicy, languageSourceFilter = 'all') {
  let whereClauses = ['active = TRUE', 'can_receive_broadcasts = TRUE'];
  const values = [];

  // 1. Фильтр по тарифам (Premium учитывает Unlimited с premium_limit IS NULL)
  if (targetAudience === 'free_users') {
    whereClauses.push(`(premium_until IS NULL OR premium_until < NOW() OR (premium_limit <= COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3) AND premium_limit IS NOT NULL))`);
  } else if (targetAudience === 'premium_users') {
    whereClauses.push(`(premium_until IS NOT NULL AND premium_until >= NOW() AND (premium_limit > COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3) OR premium_limit IS NULL))`);
  }

  // 2. Сегментация языка (динамическая)
  const segmentExpr = getSqlLanguageSegmentExpr();

  // 3. Фильтр по языкам
  if (targetLanguages && !targetLanguages.includes('all')) {
    const langConditions = [];
    for (const lang of SUPPORTED_LANGUAGES) {
      if (targetLanguages.includes(lang)) {
        langConditions.push(`${segmentExpr} = '${lang}'`);
      }
    }
    if (targetLanguages.includes('unknown') && unknownLanguagePolicy !== 'exclude') {
      langConditions.push(`${segmentExpr} = 'unknown'`);
    }
    
    if (langConditions.length > 0) {
      whereClauses.push(`(${langConditions.join(' OR ')})`);
    } else {
      whereClauses.push('FALSE');
    }
  } else {
    if (unknownLanguagePolicy === 'exclude') {
      whereClauses.push(`${segmentExpr} != 'unknown'`);
    }
  }

  // 4. Фильтр по источнику языка
  if (languageSourceFilter && languageSourceFilter !== 'all') {
    values.push(languageSourceFilter);
    whereClauses.push(`language_source = $${values.length}`);
  }

  const whereSql = whereClauses.join(' AND ');
  return { whereSql, segmentExpr, values };
}

export async function estimateBroadcastAudience(targetAudience, targetLanguages, unknownLanguagePolicy, languageSourceFilter, messagesJson = {}, fallbackLanguage = 'ru') {
  const { whereSql, segmentExpr, values } = buildBroadcastAudienceQuery(targetAudience, targetLanguages, unknownLanguagePolicy, languageSourceFilter);
  
  const sql = `
    SELECT 
      ${segmentExpr} AS segment,
      COUNT(*)::int AS count
    FROM users
    WHERE ${whereSql}
    GROUP BY ${segmentExpr}
  `;
  
  const { rows } = await query(sql, values);
  
  const stats = { total: 0, ru: 0, en: 0, unknown: 0, excluded: 0, excluded_by_language: 0, excluded_unknown: 0, excluded_missing_translation: 0 };
  
  let ruCount = 0;
  let enCount = 0;
  let unknownCount = 0;
  
  for (const row of rows) {
    if (row.segment === 'ru') ruCount = row.count;
    else if (row.segment === 'en') enCount = row.count;
    else if (row.segment === 'unknown') unknownCount = row.count;
  }
  
  // Исключено только если отсутствуют и собственный перевод, и fallback-текст.
  const missingTranslation = countUndeliverableRecipients({
    ru: ruCount,
    en: enCount,
    unknown: unknownCount,
    messagesJson,
    fallbackLanguage,
    unknownLanguagePolicy
  });
  
  stats.ru = ruCount;
  stats.en = enCount;
  stats.unknown = unknownCount;
  stats.excluded_missing_translation = missingTranslation;
  
  // Исключено из-за exclude политики для unknown
  if (unknownLanguagePolicy === 'exclude') {
    stats.excluded_unknown = unknownCount;
  }
  
  // Исключено по языку (если сегмент пользователя не входит в targetLanguages)
  if (targetLanguages && !targetLanguages.includes('all')) {
    if (!targetLanguages.includes('ru')) stats.excluded_by_language += ruCount;
    if (!targetLanguages.includes('en')) stats.excluded_by_language += enCount;
    if (!targetLanguages.includes('unknown')) stats.excluded_by_language += unknownCount;
  }
  
  stats.total = Math.max(0, ruCount + enCount + unknownCount - stats.excluded_missing_translation);
  
  // Общее базовое количество активных пользователей с тарифом
  let baseAudienceSql = `SELECT COUNT(*)::int AS count FROM users WHERE active = TRUE AND can_receive_broadcasts = TRUE`;
  const baseParams = [];
  if (targetAudience === 'free_users') {
    baseAudienceSql += ` AND (premium_until IS NULL OR premium_until < NOW() OR (premium_limit <= COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3) AND premium_limit IS NOT NULL))`;
  } else if (targetAudience === 'premium_users') {
    baseAudienceSql += ` AND (premium_until IS NOT NULL AND premium_until >= NOW() AND (premium_limit > COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3) OR premium_limit IS NULL))`;
  }
  if (languageSourceFilter && languageSourceFilter !== 'all') {
    baseParams.push(languageSourceFilter);
    baseAudienceSql += ` AND language_source = $1`;
  }
  
  const baseRes = await query(baseAudienceSql, baseParams);
  stats.base_audience = baseRes.rows[0].count;
  stats.excluded = Math.max(0, stats.base_audience - stats.total);

  return stats;
}

export async function createBroadcastSnapshot(broadcastId, targetAudience, targetLanguages, unknownLanguagePolicy, languageSourceFilter, messagesJson = {}, fallbackLanguage = 'ru') {
  const { whereSql, values } = buildBroadcastAudienceQuery(targetAudience, targetLanguages, unknownLanguagePolicy, languageSourceFilter);
  const segmentExpr = getSqlLanguageSegmentExpr();

  const sql = `
    INSERT INTO broadcast_log (broadcast_id, user_id, audience_language_segment, delivered_language, status)
    SELECT 
      $${values.length + 1} AS broadcast_id,
      u.id AS user_id,
      ${segmentExpr} AS audience_language_segment,
      COALESCE(
        CASE 
          WHEN (${segmentExpr}) = 'ru' AND ($${values.length + 3}::jsonb ? 'ru') THEN 'ru'
          WHEN (${segmentExpr}) = 'en' AND ($${values.length + 3}::jsonb ? 'en') THEN 'en'
          ELSE NULL
        END,
        CASE 
          WHEN (${segmentExpr}) = 'unknown' AND $${values.length + 2} = 'use_en' AND ($${values.length + 3}::jsonb ? 'en') THEN 'en'
          WHEN (${segmentExpr}) = 'unknown' AND $${values.length + 2} = 'use_ru' AND ($${values.length + 3}::jsonb ? 'ru') THEN 'ru'
          ELSE NULL
        END,
        $${values.length + 4}
      ) AS delivered_language,
      'pending' AS status
    FROM users u
    WHERE ${whereSql}
    ON CONFLICT (broadcast_id, user_id) DO NOTHING
  `;

  const fallbackPolicy = unknownLanguagePolicy === 'use_en' ? 'use_en' : 'use_ru';
  const result = await query(sql, [...values, broadcastId, fallbackPolicy, JSON.stringify(messagesJson), fallbackLanguage]);
  return result.rowCount || 0;
}

export async function startCampaignTransaction(broadcastId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Блокируем строку кампании
    const res = await client.query('SELECT * FROM broadcast_tasks WHERE id = $1 FOR UPDATE', [broadcastId]);
    const campaign = res.rows[0];
    
    if (!campaign) {
      throw new Error('Кампания не найдена.');
    }
    if (campaign.status !== 'pending') {
      throw new Error('Кампания уже запущена или обработана.');
    }
    if (!campaign.launch_confirmed_at || campaign.launch_confirmed_by === null) {
      throw new Error('Campaign launch confirmation is required.');
    }
    const switchResult = await client.query(
      `SELECT COALESCE(
         (SELECT value::boolean FROM app_settings WHERE key = 'broadcasts_enabled'),
         FALSE
       ) AS enabled`
    );
    if (switchResult.rows[0]?.enabled !== true) {
      throw new Error('Broadcasts are disabled by the global kill switch.');
    }

    // Динамическая валидация переводов
    const targetLangs = campaign.target_languages || ['all'];
    const messages = campaign.messages_json || {};
    const broadcastType = campaign.broadcast_type || 'marketing';

    if (broadcastType === 'system_update') {
      // Для system_update достаточно хотя бы одного заполненного языка
      const hasAnyMessage = SUPPORTED_LANGUAGES.some(lang => messages[lang]?.message);
      if (!hasAnyMessage) {
        throw new Error('Для system_update должно быть заполнено сообщение хотя бы на одном языке.');
      }
    } else {
      // Для остальных типов требуем все переводы для выбранных языков
      for (const lang of SUPPORTED_LANGUAGES) {
        if (targetLangs.includes('all') || targetLangs.includes(lang)) {
          if (!messages[lang]?.message) {
            throw new Error(`Отсутствует перевод сообщения для языка: ${lang.toUpperCase()}`);
          }
        }
      }
      
      if (targetLangs.includes('all') || targetLangs.includes('unknown')) {
        const policy = campaign.unknown_language_policy;
        if (policy === 'use_ru' && !messages.ru?.message) {
          throw new Error('Для пользователей с неизвестным языком выбрана политика RU, но русский текст не заполнен.');
        }
        if (policy === 'use_en' && !messages.en?.message) {
          throw new Error('Для пользователей с неизвестным языком выбрана политика EN, но английский текст не заполнен.');
        }
      }
    }


    // Создаем snapshot в broadcast_log
    await createBroadcastSnapshot(
      broadcastId,
      campaign.target_audience,
      campaign.target_languages,
      campaign.unknown_language_policy,
      campaign.language_source_filter,
      campaign.messages_json,
      campaign.fallback_language || 'ru'
    );

    // Подсчитываем размер созданной аудитории
    const countRes = await client.query(
      `SELECT COUNT(*)::int AS count FROM broadcast_log WHERE broadcast_id = $1`,
      [broadcastId]
    );
    const totalCount = countRes.rows[0].count;

    // Обновляем статус кампании
    await client.query(`
      UPDATE broadcast_tasks
      SET status = 'processing', started_at = NOW()
      WHERE id = $1
    `, [broadcastId]);

    await client.query('COMMIT');
    return totalCount;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getUsersForBroadcastBatch(broadcastId, audience, limit) {
  // Выбираем получателей из snapshot (broadcast_log) со статусом pending
  const sql = `
    SELECT l.user_id AS id, l.audience_language_segment, l.delivered_language, u.first_name
    FROM broadcast_log l
    JOIN users u ON l.user_id = u.id
    WHERE l.broadcast_id = $1 AND l.status = 'pending'
    ORDER BY l.user_id
    LIMIT $2
  `;
  const { rows } = await query(sql, [broadcastId, limit]);
  return rows;
}

export async function logBroadcastSent(broadcastId, userId, status = 'sent', audienceSegment = null, deliveredLang = null) {
  await query(
    `INSERT INTO broadcast_log (broadcast_id, user_id, status, audience_language_segment, delivered_language, sent_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (broadcast_id, user_id) DO UPDATE
     SET status = EXCLUDED.status,
         audience_language_segment = COALESCE(broadcast_log.audience_language_segment, EXCLUDED.audience_language_segment),
         delivered_language = COALESCE(broadcast_log.delivered_language, EXCLUDED.delivered_language),
         sent_at = NOW()`,
    [broadcastId, userId, status, audienceSegment, deliveredLang]
  );
}

export async function getBroadcastProgress(broadcastId, audience) {
  try {
    const result = await query(
      `SELECT
         COUNT(*)::int AS targeted,
         COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
         COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked,
         COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending
       FROM broadcast_log
       WHERE broadcast_id = $1`,
      [broadcastId]
    );
    const counts = result.rows[0] || {};
    const targeted = Number(counts.targeted || 0);
    const sent = Number(counts.sent || 0);
    const failed = Number(counts.failed || 0);
    const blocked = Number(counts.blocked || 0);
    const cancelled = Number(counts.cancelled || 0);
    const pending = Number(counts.pending || 0);
    const processed = sent + failed + blocked + cancelled;

    return { total: targeted, targeted, processed, sent, failed, blocked, cancelled, pending };
  } catch (err) {
    console.error('[DB] Ошибка в getBroadcastProgress:', err);
    throw err;
  }
}

export async function logLanguageChange(userId, prevLang, newLang, prevSource, newSource, changedByType, changedByUserId = null) {
  await query(
    `INSERT INTO language_history (user_id, previous_language, new_language, previous_source, new_source, changed_by_type, changed_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, prevLang, newLang, prevSource, newSource, changedByType, changedByUserId]
  );
}
export async function updateBroadcastStatus(taskId, status, errorMessage = null) {
  const report = status === 'failed' ? JSON.stringify({ error: errorMessage }) : null;
  const completedAt = status === 'completed' ? 'NOW()' : 'NULL';
  const sql = `
    UPDATE broadcast_tasks
    SET status = $1,
        report = COALESCE($2, report),
        completed_at = ${completedAt}
    WHERE id = $3 AND status <> 'cancelled'
    RETURNING status
  `;
  const { rows } = await query(sql, [status, report, taskId]);
  return rows[0] || null;
}

export async function findAndInterruptActiveBroadcast() {
  const sql = `
    UPDATE broadcast_tasks
    SET status = CASE
          WHEN launch_confirmed_at IS NOT NULL THEN 'pending'
          ELSE 'cancelled'
        END,
        completed_at = CASE
          WHEN launch_confirmed_at IS NULL THEN NOW()
          ELSE completed_at
        END
    WHERE status = 'processing'
    RETURNING id, status
  `;
  const { rows } = await query(sql);
  if (rows.length > 0) {
    console.log(`[Shutdown] Рассылка #${rows[0].id} переведена в статус ${rows[0].status}.`);
  }
}

export async function getAllBroadcastTasks({ limit = null } = {}) {
  const safeLimit = limit == null ? null : Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 5));
  const { rows } = await query(`
    SELECT 
      t.*, 
      COALESCE(log_counts.targeted_count, 0)::int AS targeted_count,
      COALESCE(log_counts.sent_count, 0)::int AS sent_count,
      COALESCE(log_counts.failed_count, 0)::int AS failed_count,
      COALESCE(log_counts.blocked_count, 0)::int AS blocked_count,
      COALESCE(log_counts.cancelled_count, 0)::int AS cancelled_count,
      COALESCE(log_counts.pending_count, 0)::int AS pending_count,
      COALESCE(log_counts.processed_count, 0)::int AS processed_count,

      -- Оценка до создания snapshot; после старта источником targeted является broadcast_log.
      (
        SELECT COUNT(*) 
        FROM users u 
        WHERE u.active = TRUE AND u.can_receive_broadcasts = TRUE
          AND (
            t.target_audience = 'all' OR
            t.target_audience = 'all_users' OR
            (t.target_audience = 'free_users' AND (u.premium_until IS NULL OR u.premium_until < NOW() OR (u.premium_limit <= COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3) AND u.premium_limit IS NOT NULL))) OR
            (t.target_audience = 'premium_users' AND (u.premium_until IS NOT NULL AND u.premium_until >= NOW() AND (u.premium_limit > COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3) OR u.premium_limit IS NULL)))
          )
      )::int AS estimated_count

    FROM broadcast_tasks t
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS targeted_count,
        COUNT(*) FILTER (WHERE status = 'sent')::int AS sent_count,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
        COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked_count,
        COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_count,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
        COUNT(*) FILTER (WHERE status IN ('sent', 'failed', 'blocked', 'cancelled'))::int AS processed_count
      FROM broadcast_log l
      WHERE l.broadcast_id = t.id
    ) log_counts ON TRUE
    ORDER BY t.scheduled_at DESC
    ${safeLimit == null ? '' : 'LIMIT $1'}
  `, safeLimit == null ? [] : [safeLimit]);
  
  // Парсим JSON-поле report (если оно есть)
  return rows.map(row => {
    if (typeof row.report === 'string') {
      try {
        row.report = JSON.parse(row.report);
      } catch (e) {
        // Если невалидный JSON, оставляем как есть или обнуляем
        console.warn(`[DB] Не удалось распарсить report для задачи #${row.id}`);
        row.report = { error: row.report };
      }
    }
    return row;
  });
}

export async function resetStaleBroadcasts() {
  const { data, error } = await supabase
    .from('broadcast_tasks')
    .update({ status: 'pending' })
    .eq('status', 'processing')
    .not('launch_confirmed_at', 'is', null);
  if (error) {
    console.error('[DB] Ошибка при сбросе зависших рассылок:', error);
  } else if (data && data.length > 0) {
    console.log(`[DB] Сброшено ${data.length} зависших рассылок для перезапуска.`);
  }
}

/* ========================= Прочее ========================= */

export async function resetOtherTariffsToFree() {
  console.log('[DB-Admin] Начинаю сброс нестандартных тарифов...');
  const sql = `
    UPDATE users
    SET
      premium_limit = COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3),
      premium_until = NULL,
      notified_about_expiration = FALSE
    WHERE (premium_limit IS NULL AND (premium_until IS NULL OR premium_until < NOW()))
       OR (
         premium_limit NOT IN (
           COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3),
           COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_plus'), 30),
           COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_pro'), 100),
           COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_unlim'), 10000)
         )
         AND premium_limit IS NOT NULL
       )
  `;
  const { rowCount } = await query(sql);
  console.log(`[DB-Admin] Сброшено ${rowCount} пользователей на тариф Free.`);
  return rowCount;
}

export async function getActiveFreeUsers() {
  const { rows } = await query(`SELECT id FROM users WHERE active = TRUE AND (premium_limit <= COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3) OR premium_until IS NULL OR premium_until < NOW())`);
  return rows;
}

export async function getActivePremiumUsers() {
  const { rows } = await query(
    `SELECT id
     FROM users
     WHERE active = TRUE
       AND (premium_limit > COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3) OR premium_limit IS NULL)
       AND premium_until IS NOT NULL AND premium_until >= NOW()`
  );
  return rows;
}

export async function getLatestReviews(limit = 10) {
  const { data } = await supabase
    .from('reviews')
    .select('*')
    .order('time', { ascending: false })
    .limit(limit);
  return data || [];
}

export async function logSearchQuery({ query: searchQuery, userId, resultsCount, foundInCache }) {
  if (!searchQuery || !userId) return;
  const { error } = await supabase.from('search_queries').insert({
    query: searchQuery,
    user_id: userId,
    results_count: resultsCount,
    found_in_cache: foundInCache
  });
  if (error) console.error('[DB] Ошибка логирования поискового запроса:', error.message);
}

export async function logFailedSearch({ query: searchQuery, searchType }) {
  if (!searchQuery) return;
  const { error } = await supabase.rpc('increment_failed_search', { p_query: searchQuery, p_search_type: searchType });
  if (error) console.error('[DB] Ошибка логирования неудачного поиска:', error.message);
}

export async function getTopFailedSearches(limit = 5) {
  const { data, error } = await supabase
    .from('failed_searches')
    .select('query, search_count')
    .order('search_count', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('[DB] Ошибка получения топа неудачных запросов:', error.message);
    return [];
  }
  return data;
}

export async function getTopRecentSearches(limit = 5) {
  const { data, error } = await supabase.rpc('get_top_recent_searches', { limit_count: limit });
  if (error) {
    console.error('[DB] Ошибка получения топа недавних запросов:', error.message);
    return [];
  }
  return data;
}

export async function getNewUsersCount(days = 1) {
  try {
    const safeDays = Math.max(1, parseInt(days, 10) || 1);
    const { rows } = await query(
      `SELECT COUNT(*) as count FROM users WHERE created_at >= NOW() - ($1 || ' days')::interval`,
      [safeDays]
    );
    const count = parseInt(rows[0]?.count || 0);
    console.log(`[DB] Новых пользователей за ${safeDays} дн.: ${count}`);
    return count;
  } catch (error) {
    console.error(`[DB] Ошибка getNewUsersCount(${days}):`, error.message);
    return 0;
  }
}

export async function getUserActivityByDayHour(days = 30) {
  const safeDays = Math.max(1, parseInt(days, 10) || 30);
  const { rows } = await query(`
    SELECT TO_CHAR(last_active, 'YYYY-MM-DD') AS day,
           EXTRACT(HOUR FROM last_active) AS hour,
           COUNT(*) AS count
    FROM users
    WHERE last_active >= CURRENT_DATE - ($1 || ' days')::interval
    GROUP BY day, hour
    ORDER BY day, hour
  `, [safeDays]);
  const activity = {};
  rows.forEach(row => {
    if (!activity[row.day]) activity[row.day] = Array(24).fill(0);
    activity[row.day][parseInt(row.hour, 10)] = parseInt(row.count, 10);
  });
  return activity;
}

export async function getReferredUsers(referrerId) {
  const { data, error } = await supabase
    .from('users')
    .select('id, first_name, created_at')
    .eq('referrer_id', referrerId)
    .order('created_at', { ascending: false });
  return error ? [] : data;
}

// В db.js замени getReferralStats на это:

export async function getReferralStats() {
  // 1. Топ рефоводов (с правильными ID для ссылок)
  const { rows: topReferrers } = await query(`
    SELECT 
      r.id, 
      r.first_name, 
      r.username,
      COUNT(u.id) as referral_count
    FROM users u
    JOIN users r ON u.referrer_id = r.id
    GROUP BY r.id, r.first_name, r.username
    ORDER BY referral_count DESC
    LIMIT 5
  `);

  // 2. Всего приглашено
  const { rows: totalCount } = await query(
    `SELECT COUNT(*) as count FROM users WHERE referrer_id IS NOT NULL`
  );

  return {
    topReferrers: topReferrers || [],
    totalReferred: parseInt(totalCount[0]?.count || 0, 10)
  };
}

/* ========================= Нотифаер / Уведомления ========================= */

// Ещё один способ (старый): окно N дней вперёд — оставляем для обратной совместимости
export async function findUsersToNotify(days = 3) {
  const now = new Date();
  const nowIso = now.toISOString();
  const targetIso = new Date(now.getTime() + days * 86400000).toISOString();

  const { data, error } = await supabase
    .from('users')
    .select('id, first_name, premium_until, active')
    .gte('premium_until', nowIso)
    .lte('premium_until', targetIso)
    .eq('active', true)
    .or('notified_about_expiration.is.null,notified_about_expiration.eq.false');

  if (error) {
    console.error('[DB] Ошибка поиска пользователей для уведомления:', error);
    return [];
  }
  return data || [];
}

export async function markAsNotified(userId) {
  return updateUserField(userId, 'notified_about_expiration', true);
}

// Ровно N дней вперёд (полуночные окна UTC) — для 3д/1д/0д
export async function findUsersExpiringIn(days, flagField) {
  const allowed = new Set(['notified_exp_3d', 'notified_exp_1d', 'notified_exp_0d']);
  if (!allowed.has(flagField)) {
    throw new Error(`findUsersExpiringIn: invalid flag "${flagField}"`);
  }
  
  const sql = `
    SELECT id, first_name, premium_until
    FROM users
    WHERE active = TRUE
      AND (premium_limit <> COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3) OR premium_limit IS NULL)
      AND premium_until IS NOT NULL
      AND premium_until >= date_trunc('day', (NOW() AT TIME ZONE 'UTC')) + make_interval(days => $1::int)
      AND premium_until <  date_trunc('day', (NOW() AT TIME ZONE 'UTC')) + make_interval(days => ($1::int + 1))
      AND COALESCE(${flagField}, FALSE) = FALSE
    ORDER BY premium_until ASC
  `;
  const { rows } = await query(sql, [Number(days) || 0]);
  return rows || [];
}
export async function markStageNotified(userId, flagField) {
  const allowed = new Set(['notified_exp_3d', 'notified_exp_1d', 'notified_exp_0d']);
  if (!allowed.has(flagField)) {
    throw new Error(`markStageNotified: invalid flag "${flagField}"`);
  }
  // Обновляем только если флаг ещё не был выставлен
  const { rowCount } = await query(
    `UPDATE users
     SET ${flagField} = TRUE
     WHERE id = $1 AND COALESCE(${flagField}, FALSE) = FALSE`,
    [userId]
  );
  return rowCount > 0; // true, если реально проставили флаг
}

/* ========================= Вспомогательные ========================= */

export async function getUserUsage(userId) {
  const { rows } = await query(
    `SELECT id, active, premium_limit, downloads_today, subscribed_bonus_used
     FROM users
     WHERE id = $1`,
    [userId]
  );
  return rows[0] || null;
}

export async function findCachedTracks(urls) {
  if (!urls?.length) return new Map();
  const uniq = Array.from(new Set(urls));
  const { rows } = await query(
    'SELECT url, file_id, title FROM track_cache WHERE url = ANY($1)',
    [uniq]
  );
  const map = new Map();
  rows.forEach(r => map.set(r.url, { fileId: r.file_id, trackName: r.title }));
  return map;
}

export async function incrementDownloadsAndLogPg(userId, trackTitle, fileId, url) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const newTrack = { title: trackTitle, fileId, url };

    const upd = await client.query(
      `UPDATE users
       SET downloads_today = downloads_today + 1,
           total_downloads  = total_downloads + 1,
           downloads_count  = COALESCE(downloads_count, 0) + 1,
           yandex_promo_progress = COALESCE(yandex_promo_progress, 0) + 1,
           tracks_today     = COALESCE(tracks_today, '[]'::jsonb) || $1::jsonb
       WHERE id = $2
         AND (
           (premium_until IS NOT NULL AND premium_until >= NOW() AND premium_limit IS NULL)
           OR downloads_today < CASE
             WHEN premium_until IS NOT NULL AND premium_until >= NOW()
               THEN premium_limit
             ELSE COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3)
           END
         )
       RETURNING id`,
      [newTrack, userId]
    );

    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query(
      `INSERT INTO downloads_log (user_id, track_title, url, downloaded_at)
       VALUES ($1, $2, $3, NOW())`,
      [userId, trackTitle, url]
    );

    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DB] incrementDownloadsAndLogPg error:', e.message);
    return null;
  } finally {
    client.release();
  }
}
// db.js -- ОБНОВЛЕННАЯ ВЕРСИЯ ФУНКЦИИ

/**
 * @description Получает пользователей, у которых премиум-подписка истекает в ближайшие 3 дня.
 * @returns {Promise<Array<{id: number, username: string, first_name: string, premium_until: string, premium_limit: number}>>}
 */
/**
 * Получает пользователей с истекающей подпиской (0-3 дня)
 */
export async function getExpiringUsers(days = 7) {
  try {
    const sql = `
      SELECT id, username, first_name, premium_until, premium_limit
      FROM users
      WHERE premium_until IS NOT NULL
        AND premium_until BETWEEN NOW() AND NOW() + interval '${days} days'
      ORDER BY premium_until ASC
    `;
    const { rows } = await pool.query(sql);
    return rows;
  } catch (error) {
    console.error('[DB] Ошибка при получении истекающих подписок:', error);
    return [];
  }
}
/**
 * Получает все настройки из таблицы app_settings
 */
export async function getAppSettings() {
  const { rows } = await query('SELECT key, value FROM app_settings');
  const settings = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

/**
 * Обновляет одну настройку
 */
export async function setAppSetting(key, value) {
  await query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}
// db.js

/**
 * Находит запись в кэше по file_id
 */
export async function findCachedTrackByFileId(fileId) {
  try {
    const { rows } = await query(
      'SELECT url, title, artist FROM track_cache WHERE file_id = $1 LIMIT 1',
      [fileId]
    );
    return rows[0] || null;
  } catch (e) {
    console.error('[DB] Ошибка findCachedTrackByFileId:', e.message);
    return null;
  }
}

/**
 * Обновляет file_id для записи в кэше, найденной по старому file_id
 */
export async function updateFileId(oldFileId, newFileId) {
  try {
    const { rowCount } = await query(
      'UPDATE track_cache SET file_id = $1 WHERE file_id = $2',
      [newFileId, oldFileId]
    );
    return rowCount;
  } catch (e) {
    console.error('[DB] Ошибка updateFileId:', e.message);
    return 0;
  }
}
// db.js

/**
 * Получает все уникальные URL, которые когда-либо скачивал пользователь.
 */
export async function getUserUniqueDownloadedUrls(userId) {
  try {
    const { rows } = await query(
      'SELECT DISTINCT url FROM downloads_log WHERE user_id = $1',
      [userId]
    );
    // Возвращаем массив строк, а не объектов
    return rows.map(row => row.url);
  } catch (e) {
    console.error(`[DB] Ошибка getUserUniqueDownloadedUrls для ${userId}:`, e.message);
    return [];
  }
}
export async function resetCacheForUserHistory(userId, beforeDate = '2024-11-17') {
  try {
    // 1. Находим уникальные URL, которые качал юзер до даты фикса
    // 2. Обновляем таблицу track_cache, обнуляя file_id для этих URL
    const sql = `
      UPDATE track_cache
      SET file_id = NULL
      WHERE url IN (
        SELECT DISTINCT url 
        FROM downloads_log 
        WHERE user_id = $1 
          AND downloaded_at < $2::date
      )
      AND file_id IS NOT NULL
    `;
    
    const { rowCount } = await query(sql, [userId, beforeDate]);
    console.log(`[DB Fix] Пользователь ${userId}: сброшен кэш для ${rowCount} треков.`);
    return rowCount;
  } catch (e) {
    console.error('[DB Fix Error]', e.message);
    return 0;
  }
}

// db.js - ЗАМЕНИТЕ существующую функцию deleteCachedTrack на эту:

export async function deleteCachedTrack(urlOrKey) {
  if (!urlOrKey) return false;
  
  try {
    // Удаляем из таблицы track_cache (не tracks!)
    const { rowCount } = await query(
      `DELETE FROM track_cache WHERE url = $1`,
      [urlOrKey]
    );
    
    // Также пробуем удалить из алиасов
    await query(
      `DELETE FROM track_url_aliases WHERE canonical_url = $1 OR alias_url = $1`,
      [urlOrKey]
    ).catch(() => {}); // Игнорируем если таблица не существует
    
    if (rowCount > 0) {
      console.log(`[DB] Удалён кэш для: ${urlOrKey}`);
    }
    
    return rowCount > 0;
  } catch (e) {
    console.error('[DB] Ошибка удаления кэша:', e.message);
    return false;
  }
}
// Функция для экстренной очистки базы от проблемных треков
export async function cleanUpDatabase() {
    try {
        console.log('[DB Clean] Начинаю очистку...');

        // 1. Удаляем проблемный трек "Wrong Side of Heaven" по части названия
        const { rowCount: count1 } = await query(
            "DELETE FROM track_cache WHERE title ILIKE '%wrong%side%of%heaven%' OR url ILIKE '%wrong-side-of-heaven%'"
        );

        // 2. Удаляем короткие треки (меньше 20 секунд), так как это обычно превью
        const { rowCount: count2 } = await query(
            "DELETE FROM track_cache WHERE duration < 20"
        );
        
        // 3. Также удаляем алиасы для этих треков (опционально, если есть внешние ключи, они удалятся сами, но на всякий случай)
        await query(
             "DELETE FROM track_url_aliases WHERE canonical_url NOT IN (SELECT url FROM track_cache)"
        ).catch(() => {});

        console.log(`[DB Clean] Готово. Удалено specific: ${count1}, short: ${count2}`);
        return true;
    } catch (e) {
        console.error('[DB Clean] Критическая ошибка:', e);
        return false;
    }
}

// === УПРАВЛЕНИЕ ПРОБЛЕМНЫМИ ТРЕКАМИ ===

/**
 * Логирует проблемный трек в базу для админки
 */
export async function logBrokenTrack(url, title, userId, reason) {
  try {
    await query(`
      INSERT INTO failed_tracks (url, title, user_id, reason, is_fixed, created_at)
      VALUES ($1, $2, $3, $4, false, NOW())
      ON CONFLICT (url) DO UPDATE SET
        title = EXCLUDED.title,
        user_id = EXCLUDED.user_id,
        reason = EXCLUDED.reason,
        is_fixed = false,
        created_at = NOW()
    `, [url, title || 'Unknown', userId, reason]);
    
    console.log(`[DB] 📝 Трек добавлен в реестр ошибок: ${title}`);
  } catch (e) {
    console.error('[DB] Ошибка logBrokenTrack:', e.message);
  }
}

/**
 * Получение списка проблемных треков для админки
 */
export async function getBrokenTracks(limit = 50) {
  try {
    const { rows } = await query(`
      SELECT * FROM failed_tracks 
      WHERE is_fixed = false 
      ORDER BY created_at DESC 
      LIMIT $1
    `, [limit]);
    return rows || [];
  } catch (error) {
    console.error('[DB] Ошибка получения broken tracks:', error.message);
    return [];
  }
}

/**
 * Пометить трек как исправленный
 */
export async function resolveBrokenTrack(id) {
  try {
    await query(`UPDATE failed_tracks SET is_fixed = true WHERE id = $1`, [id]);
    return true;
  } catch (error) {
    console.error('[DB] Ошибка resolveBrokenTrack:', error.message);
    return false;
  }
}
// ============================================
// ПРОБЛЕМНЫЕ ТРЕКИ - РАСШИРЕННЫЕ ФУНКЦИИ
// ============================================

/**
 * Получить проблемные треки с пагинацией и статистикой
 */
export async function getBrokenTracksWithPagination({ page = 1, limit = 25 } = {}) {
  const offset = (page - 1) * limit;
  
  try {
    // Общее количество неисправленных (прямой SQL обходит RLS)
    const countResult = await query(`
      SELECT COUNT(*) as count FROM failed_tracks WHERE is_fixed = false
    `);
    const totalTracks = parseInt(countResult.rows[0]?.count || 0);
    
    console.log(`[DB] Битых треков найдено: ${totalTracks}`);
    
    // Треки с пагинацией и информацией о пользователях
    const tracksResult = await query(`
      SELECT 
        ft.*,
        u.username,
        u.first_name
      FROM failed_tracks ft
      LEFT JOIN users u ON ft.user_id = u.id
      WHERE ft.is_fixed = false
      ORDER BY ft.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    
    const tracks = tracksResult.rows || [];
    
    return {
      tracks,
      totalTracks,
      totalPages: Math.ceil(totalTracks / limit),
      currentPage: page
    };
    
  } catch (e) {
    console.error('[DB] getBrokenTracksWithPagination error:', e.message);
    return {
      tracks: [],
      totalTracks: 0,
      totalPages: 0,
      currentPage: page
    };
  }
}

/**
 * Удалить запись о проблемном треке (полное удаление)
 */
export async function deleteBrokenTrack(id) {
  try {
    const { rows } = await query(`
      DELETE FROM failed_tracks WHERE id = $1 RETURNING *
    `, [id]);
    return rows[0] || null;
  } catch (e) {
    console.error('[DB] deleteBrokenTrack error:', e.message);
    return null;
  }
}

/**
 * Массовое удаление проблемных треков
 */
export async function deleteBrokenTracksBulk(ids) {
  if (!ids || ids.length === 0) return 0;
  
  try {
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const { rowCount } = await query(`
      DELETE FROM failed_tracks WHERE id IN (${placeholders})
    `, ids);
    return rowCount || 0;
  } catch (e) {
    console.error('[DB] deleteBrokenTracksBulk error:', e.message);
    return 0;
  }
}

export async function deleteAllBrokenTracks() {
  try {
    const { rowCount } = await query('DELETE FROM failed_tracks');
    return rowCount || 0;
  } catch (e) {
    console.error('[DB] deleteAllBrokenTracks error:', e.message);
    return 0;
  }
}

/**
 * Увеличить счетчик попыток для трека
 */
export async function incrementBrokenTrackRetry(id) {
  try {
    const { rows } = await query(`
      UPDATE failed_tracks 
      SET retry_count = COALESCE(retry_count, 0) + 1,
          updated_at = NOW()
      WHERE id = $1
      RETURNING retry_count
    `, [id]);
    return rows[0]?.retry_count || 0;
  } catch (e) {
    console.error('[DB] incrementBrokenTrackRetry error:', e.message);
    return 0;
  }
}
export async function fixBadCacheForUser(userId, dateLimit) {
  try {
    const limit = dateLimit || new Date().toISOString().split('T')[0];
    console.log(`[Debug] 🛠 Начинаю фикс для User ${userId}. Дата отсечки: ${limit}`);
    
    const logRes = await query(
      `SELECT DISTINCT url FROM downloads_log WHERE user_id = $1 AND downloaded_at < $2::date`,
      [userId, limit]
    );
    
    const urls = logRes.rows.map(r => r.url);
    console.log(`[Debug] 📂 Найдено в истории пользователя: ${urls.length} ссылок.`);
    
    if (urls.length === 0) {
      return 0;
    }
    
    // Исправление: ставим пустую строку вместо NULL
    const updateSql = `
      UPDATE track_cache
      SET file_id = ''
      WHERE url = ANY($1)
      AND file_id IS NOT NULL 
      AND file_id != ''
    `;
    
    const updateRes = await query(updateSql, [urls]);
    console.log(`[Debug] ✅ Успешно сброшено file_id у ${updateRes.rowCount} треков.`);
    
    return updateRes.rowCount;
    
  } catch (e) {
    console.error('[DB Fix Error]', e);
    return 0;
  }
}

/* ========================= РЕКЛАМНЫЕ КАМПАНИИ (PROMOS) ========================= */

export async function markYandexMusicPromoShown(userId) {
  const res = await query(
    `UPDATE users SET yandex_music_promo_shown = true
     WHERE id = $1 AND COALESCE(yandex_music_promo_shown, false) = false
     RETURNING id`,
    [userId]
  );
  return res.rowCount > 0;
}

export async function getPromoCampaigns() {
  const { rows } = await query('SELECT * FROM promo_campaigns ORDER BY id ASC');
  return rows;
}

export async function createPromoCampaign(data) {
  const { name, trigger_downloads, message_text, button_text, url, is_active } = data;
  const { rows } = await query(
    `INSERT INTO promo_campaigns (name, trigger_downloads, message_text, button_text, url, is_active)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [name, trigger_downloads, message_text, button_text, url, is_active ?? true]
  );
  return rows[0];
}

export async function updatePromoCampaign(id, data) {
  const { name, trigger_downloads, message_text, button_text, url, is_active } = data;
  const { rows } = await query(
    `UPDATE promo_campaigns
     SET name = $1, trigger_downloads = $2, message_text = $3, button_text = $4, url = $5, is_active = $6
     WHERE id = $7
     RETURNING *`,
    [name, trigger_downloads, message_text, button_text, url, is_active, id]
  );
  return rows[0];
}

export async function deletePromoCampaign(id) {
  if (Number(id) === 1 || Number(id) === 2) {
    throw new Error('Нельзя удалить системную кампанию');
  }
  await query('DELETE FROM promo_campaigns WHERE id = $1', [id]);
}

export async function markCustomPromoShown(userId, campaignId) {
  const res = await query(
    `INSERT INTO user_promo_progress (user_id, campaign_id, progress, shown)
     VALUES ($1, $2, 0, true)
     ON CONFLICT (user_id, campaign_id) DO UPDATE SET shown = true
     WHERE user_promo_progress.shown = false
     RETURNING user_id`,
    [userId, campaignId]
  );
  return res.rowCount > 0;
}

export async function getPromoStats() {
  const stats = {};
  
  const res1 = await query('SELECT COUNT(*)::int as count FROM users WHERE yandex_promo_shown = true');
  stats[1] = res1.rows[0]?.count || 0;
  
  const res2 = await query('SELECT COUNT(*)::int as count FROM users WHERE yandex_music_promo_shown = true');
  stats[2] = res2.rows[0]?.count || 0;
  
  const resCustom = await query(
    'SELECT campaign_id, COUNT(*)::int as count FROM user_promo_progress WHERE shown = true GROUP BY campaign_id'
  );
  for (const row of resCustom.rows) {
    stats[row.campaign_id] = row.count;
  }
  
  return stats;
}

export async function getCustomPromoProgressForUser(userId) {
  const { rows } = await query(
    `SELECT p.*, c.trigger_downloads, c.message_text, c.button_text, c.url, c.is_active 
     FROM user_promo_progress p
     JOIN promo_campaigns c ON p.campaign_id = c.id
     WHERE p.user_id = $1`,
    [userId]
  );
  return rows;
}

export async function resetPromoCampaign(id) {
  const campaignId = Number(id);
  if (campaignId === 1) {
    await query('UPDATE users SET yandex_promo_shown = false, yandex_promo_progress = 0');
  } else if (campaignId === 2) {
    await query('UPDATE users SET yandex_music_promo_shown = false');
  } else {
    // Для кастомных кампаний сбрасываем как статус shown, так и прогресс, чтобы отсчет пошел заново
    await query('UPDATE user_promo_progress SET shown = false, progress = 0 WHERE campaign_id = $1', [campaignId]);
  }
}

/* ========================= Служба техподдержки (Тикеты) ========================= */

export async function runSupportSystemMigration() {
  const sql = `
    -- 1. Добавление колонки режима поддержки для пользователей
    ALTER TABLE users 
    ADD COLUMN IF NOT EXISTS support_mode boolean DEFAULT false;

    -- 2. Создание таблицы сообщений поддержки
    CREATE TABLE IF NOT EXISTS support_messages (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_text TEXT NOT NULL,
      sender VARCHAR(50) NOT NULL CHECK (sender IN ('user', 'admin')),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      is_read BOOLEAN DEFAULT FALSE
    );

    -- Индекс для быстрого поиска сообщений конкретного пользователя
    CREATE INDEX IF NOT EXISTS idx_support_messages_user ON support_messages(user_id);

    -- 3. Обновляем лимит существующих пользователей с 5 до динамического лимита Free, чтобы соответствовать тарифной сетке (отключено по требованию)
    -- UPDATE users SET premium_limit = COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3) WHERE premium_limit = 3;

    -- 4. Добавляем колонки для поддержки медиафайлов в техподдержке
    ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS media_type VARCHAR(50) DEFAULT 'text';
    ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS file_id TEXT DEFAULT NULL;
    ALTER TABLE support_messages ALTER COLUMN message_text DROP NOT NULL;
  `;
  try {
    await query(sql);
    console.log('✅ [DB] Автоматическая миграция службы поддержки выполнена успешно.');
  } catch (err) {
    console.error('❌ [DB] Ошибка автоматической миграции службы поддержки:', err.message);
  }
}

export async function runAnalyticsSystemMigration() {
  try {
    const migrationPath = path.join(__dirname, 'migrations', '006_analytics_system.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    await query(sql);
    console.log('✅ [DB] Автоматическая миграция аналитики и платежей Stars выполнена успешно.');
  } catch (err) {
    console.error('❌ [DB] Ошибка автоматической миграции аналитики и платежей Stars:', err.message);
    throw err;
  }
}

export async function runMultilangSystemMigration() {
  try {
    const migrationPath = path.join(__dirname, 'migrations', '007_multilang_system.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    await query(sql);
    console.log('✅ [DB] Автоматическая миграция мультиязычности и рассылок (007) выполнена успешно.');
  } catch (err) {
    console.error('❌ [DB] Ошибка автоматической миграции мультиязычности и рассылок (007):', err.message);
    throw err;
  }
}

export async function runPreflightFixesMigration() {
  try {
    const migrationFiles = [
      '009_schema_contract_reconciliation.sql',
      '010_broadcast_launch_safety.sql'
    ];
    for (const migrationFile of migrationFiles) {
      const migrationPath = path.join(__dirname, 'migrations', migrationFile);
      const sql = fs.readFileSync(migrationPath, 'utf8');
      await query(sql);
      console.log(`✅ [DB] Миграция ${migrationFile} выполнена успешно.`);
    }
  } catch (err) {
    console.error('❌ [DB] Ошибка миграций контракта схемы:', err.message);
    throw err;
  }
}

export async function createSupportMessage(userId, text, sender, mediaType = 'text', fileId = null) {
  const sql = `
    INSERT INTO support_messages (user_id, message_text, sender, is_read, media_type, file_id)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `;
  // Если отправитель - админ, сообщение считается прочитанным по умолчанию
  const isRead = sender === 'admin';
  const { rows } = await query(sql, [userId, text, sender, isRead, mediaType, fileId]);
  return rows[0];
}

export async function getSupportTickets() {
  const sql = `
    SELECT 
      u.id as user_id, 
      u.first_name, 
      u.username,
      m.message_text as last_message,
      m.created_at as last_message_time,
      (SELECT COUNT(*)::int FROM support_messages WHERE user_id = u.id AND sender = 'user' AND is_read = false) as unread_count
    FROM (
      SELECT DISTINCT ON (user_id) user_id, message_text, created_at
      FROM support_messages
      ORDER BY user_id, created_at DESC
    ) m
    JOIN users u ON m.user_id = u.id
    ORDER BY m.created_at DESC
  `;
  const { rows } = await query(sql);
  return rows;
}

export async function getSupportMessages(userId) {
  const sql = `
    SELECT * 
    FROM support_messages 
    WHERE user_id = $1 
    ORDER BY created_at ASC
  `;
  const { rows } = await query(sql, [userId]);
  return rows;
}

export async function markSupportMessagesAsRead(userId) {
  const sql = `
    UPDATE support_messages 
    SET is_read = true 
    WHERE user_id = $1 AND sender = 'user' AND is_read = false
  `;
  await query(sql, [userId]);
}

export async function deleteSupportMessages(userId) {
  const sql = `
    DELETE FROM support_messages 
    WHERE user_id = $1
  `;
  await query(sql, [userId]);
}

export async function getUnreadSupportTicketsCount() {
  const sql = `
    SELECT COUNT(DISTINCT user_id)::int as count 
    FROM support_messages 
    WHERE sender = 'user' AND is_read = false
  `;
  try {
    const { rows } = await query(sql);
    return rows[0]?.count || 0;
  } catch (e) {
    console.error('[DB] getUnreadSupportTicketsCount error:', e.message);
    return 0;
  }
}

// =====================================================================================
//                       KARAOKE LRC MAKER INTEGRATION (MVP)
// =====================================================================================

export async function grantKaraokeTesterAccess(telegramId, username, firstName, limit = 50) {
  try {
    const sql = `SELECT public.grant_karaoke_tester_access($1, $2, $3, 'music_bot', 30, $4) AS result`;
    const { rows } = await karaokeQuery(sql, [telegramId, username, firstName, limit]);
    return rows[0]?.result;
  } catch (e) {
    console.error('[DB] grantKaraokeTesterAccess error:', e.message);
    return { success: false, status: 'error', message: e.message };
  }
}

export async function getKaraokeTester(telegramId) {
  try {
    const sql = `SELECT * FROM public.karaoke_testers WHERE telegram_id = $1`;
    const { rows } = await karaokeQuery(sql, [telegramId]);
    return rows[0] || null;
  } catch (e) {
    console.error('[DB] getKaraokeTester error:', e.message);
    return null;
  }
}

export async function addKaraokeFeedback({ telegramId, messageText, attachmentUrl, attachmentType, contact }) {
  try {
    // 1. Находим user_id (UUID) в public.profiles если есть
    const profileRes = await karaokeQuery(`SELECT id FROM public.profiles WHERE telegram_id = $1`, [telegramId]);
    const userId = profileRes.rows[0]?.id || null;
    
    // 2. Скриншоты в JSONB массив
    const screenshots = attachmentUrl ? [attachmentUrl] : [];
    
    // 3. Сохраняем в public.feedback
    const sql = `
      INSERT INTO public.feedback (
        user_id, telegram_id, type, status, message, contact, screenshots, technical_data
      ) VALUES ($1, $2, 'other', 'new', $3, $4, $5::jsonb, $6::jsonb)
      RETURNING id;
    `;
    const technicalData = { source: 'telegram_bot' };
    const result = await karaokeQuery(sql, [
      userId,
      telegramId,
      messageText || '',
      contact || null,
      JSON.stringify(screenshots),
      JSON.stringify(technicalData)
    ]);
    
    // 4. Увеличиваем счетчик отзывов у тестировщика
    await karaokeQuery(`
      UPDATE public.karaoke_testers
      SET feedback_count = feedback_count + 1, updated_at = NOW()
      WHERE telegram_id = $1
    `, [telegramId]);
    
    return result.rows[0]?.id || null;
  } catch (e) {
    console.error('[DB] addKaraokeFeedback error:', e.message);
    return null;
  }
}

export async function getKaraokeTestersStats() {
  try {
    const stats = {};
    
    const totalInvited = await karaokeQuery(`SELECT COUNT(*)::int as count FROM public.karaoke_testers`);
    stats.totalInvited = totalInvited.rows[0]?.count || 0;
    
    const totalActive = await karaokeQuery(`SELECT COUNT(*)::int as count FROM public.karaoke_testers WHERE status = 'tester_active'`);
    stats.totalActive = totalActive.rows[0]?.count || 0;
    
    const totalWaitlist = await karaokeQuery(`SELECT COUNT(*)::int as count FROM public.karaoke_testers WHERE status = 'tester_waitlist'`);
    stats.totalWaitlist = totalWaitlist.rows[0]?.count || 0;
    
    const totalFeedback = await karaokeQuery(`SELECT COUNT(*)::int as count FROM public.karaoke_testers WHERE feedback_count > 0`);
    stats.totalFeedback = totalFeedback.rows[0]?.count || 0;
    
    const openedService = await karaokeQuery(`
      SELECT COUNT(DISTINCT telegram_id)::int as count FROM public.app_events 
      WHERE event_name = 'app_open' AND telegram_id IN (SELECT telegram_id FROM public.karaoke_testers WHERE status = 'tester_active')
    `);
    stats.openedService = openedService.rows[0]?.count || 0;
    
    const exportedVideos = await karaokeQuery(`
      SELECT COUNT(*)::int as count FROM public.app_events 
      WHERE event_name = 'video_export_completed' AND telegram_id IN (SELECT telegram_id FROM public.karaoke_testers WHERE status = 'tester_active')
    `);
    stats.exportedVideos = exportedVideos.rows[0]?.count || 0;
    
    const publishedKaraoke = await karaokeQuery(`
      SELECT COUNT(*)::int as count FROM public.published_karaoke 
      WHERE publisher_id IN (
        SELECT id FROM public.profiles 
        WHERE telegram_id IN (SELECT telegram_id FROM public.karaoke_testers WHERE status = 'tester_active')
      )
    `);
    stats.publishedKaraoke = publishedKaraoke.rows[0]?.count || 0;
    
    return stats;
  } catch (e) {
    console.error('[DB] getKaraokeTestersStats error:', e.message);
    return {
      totalInvited: 0,
      totalActive: 0,
      totalWaitlist: 0,
      totalFeedback: 0,
      openedService: 0,
      exportedVideos: 0,
      publishedKaraoke: 0
    };
  }
}

export async function logKaraokeInvitation(telegramId, username, firstName) {
  try {
    const sql = `
      INSERT INTO public.karaoke_testers (telegram_id, username, first_name, invited_at, status)
      VALUES ($1, $2, $3, NOW(), 'invited')
      ON CONFLICT (telegram_id) DO UPDATE
      SET username = EXCLUDED.username, first_name = EXCLUDED.first_name, invited_at = NOW()
      WHERE public.karaoke_testers.status = 'invited' OR public.karaoke_testers.status IS NULL
    `;
    await karaokeQuery(sql, [telegramId, username, firstName]);
  } catch (e) {
    console.error('[DB] logKaraokeInvitation error:', e.message);
  }
}

// === TELEGRAM STARS & MANUAL PAYMENTS INTEGRATION ===

export async function processStarsPayment({ userId, orderId, telegramPaymentChargeId, providerPaymentChargeId, amountMinor, currency, invoicePayload }) {
  const { rows } = await query(
    `SELECT public.process_stars_payment($1, $2, $3, $4, $5, $6, $7, 'telegram_stars_rpc', NULL) AS result`,
    [userId, orderId, telegramPaymentChargeId, providerPaymentChargeId, amountMinor, currency, invoicePayload]
  );
  return rows[0]?.result || null;
}

export async function processManualPayment({ adminId, userId, plan, amountMinor, currency, paymentMethod, periodDays, comment }) {
  const { rows } = await query(
    `SELECT public.process_manual_payment($1, $2, $3, $4, $5, $6, $7, $8) AS result`,
    [adminId, userId, plan, amountMinor, currency, paymentMethod, periodDays, comment]
  );
  return rows[0]?.result || null;
}

export async function createPaymentOrder({ userId, plan, amountMinor, currency, placement, campaignId, periodDays }) {
  const expiresAt = new Date(Date.now() + 2 * 3600 * 1000); // Expires in 2 hours
  const { rows } = await query(
    `INSERT INTO payment_orders (user_id, plan, amount_minor, currency, placement, campaign_id, period_days, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [userId, plan, amountMinor, currency, placement, campaignId, periodDays, expiresAt]
  );
  return rows[0];
}

export async function getPaymentOrder(orderId) {
  const { rows } = await query(
    `SELECT * FROM payment_orders WHERE id = $1`,
    [orderId]
  );
  return rows[0] || null;
}

// === АГРЕГАЦИЯ АНАЛИТИКИ (ВРЕМЕННАЯ ЗОНА EUROPE/MOSCOW) ===

export async function aggregateDailyStats(targetDayStr = null) {
  // Получаем текущую дату по московскому времени
  const day = targetDayStr || new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
  let client = null;

  try {
    client = await pool.connect();
    
    // Начинаем транзакцию
    await client.query('BEGIN');
    
    // Пытаемся получить транзакционную advisory lock на эту конкретную дату
    const lockRes = await client.query(`SELECT pg_try_advisory_xact_lock(hashtext('aggregate_stats:' || $1)) as locked`, [day]);
    if (!lockRes.rows[0].locked) {
      console.log(`[Analytics/Aggregate] Пропуск: Агрегация за день ${day} уже выполняется другим процессом.`);
      await client.query('ROLLBACK');
      return;
    }

    console.log(`[Analytics/Aggregate] Запуск агрегации за день (Europe/Moscow): ${day}`);

    // Границы суток МСК в формате ISO со смещением +03:00
    const mskStart = `${day}T00:00:00+03:00`;
    const mskEnd = `${day}T23:59:59.999+03:00`;

    // 1. DAU: Уникальные пользователи, совершившие live-действия (исключая системные)
    const dauRes = await client.query(
      `SELECT COUNT(DISTINCT user_id)::int AS dau 
       FROM analytics_events 
       WHERE created_at BETWEEN $1 AND $2 
         AND event_origin = 'live'
         AND event_name NOT IN ('session_started')`,
      [mskStart, mskEnd]
    );
    const dau = dauRes.rows[0].dau || 0;

    // 2. WAU (скользящие 7 дней)
    const wskStart = new Date(new Date(mskStart).getTime() - 6 * 86400000).toISOString();
    const wauRes = await client.query(
      `SELECT COUNT(DISTINCT user_id)::int AS wau 
       FROM analytics_events 
       WHERE created_at BETWEEN $1 AND $2 
         AND event_origin = 'live'
         AND event_name NOT IN ('session_started')`,
      [wskStart, mskEnd]
    );
    const wau = wauRes.rows[0].wau || 0;

    // 3. MAU (скользящие 30 дней)
    const mskStart30 = new Date(new Date(mskStart).getTime() - 29 * 86400000).toISOString();
    const mauRes = await client.query(
      `SELECT COUNT(DISTINCT user_id)::int AS mau 
       FROM analytics_events 
       WHERE created_at BETWEEN $1 AND $2 
         AND event_origin = 'live'
         AND event_name NOT IN ('session_started')`,
      [mskStart30, mskEnd]
    );
    const mau = mauRes.rows[0].mau || 0;

    // 4. Новые регистрации
    const regRes = await client.query(
      `SELECT COUNT(*)::int AS count 
       FROM users 
       WHERE created_at BETWEEN $1 AND $2`,
      [mskStart, mskEnd]
    );
    const registrations = regRes.rows[0].count || 0;

    // 5. Успешные загрузки из downloads_log (источник истины)
    const dlTotalRes = await client.query(
      `SELECT COUNT(*)::int AS total 
       FROM downloads_log 
       WHERE downloaded_at BETWEEN $1 AND $2`,
      [mskStart, mskEnd]
    );
    const downloadsTotal = dlTotalRes.rows[0].total || 0;

    // Скачивания из кэша
    const cacheHitsRes = await client.query(
      `SELECT COUNT(*)::int AS cache_hits 
       FROM analytics_events 
       WHERE event_name = 'track_download_success' 
         AND event_data->>'delivery_source' = 'cache'
         AND created_at BETWEEN $1 AND $2`,
      [mskStart, mskEnd]
    );
    const cacheHits = cacheHitsRes.rows[0].cache_hits || 0;
    const downloadsNew = Math.max(downloadsTotal - cacheHits, 0);

    // 6. Достижения лимита
    const limitsRes = await client.query(
      `SELECT COUNT(*)::int AS count 
       FROM analytics_events 
       WHERE event_name = 'daily_limit_reached' 
         AND created_at BETWEEN $1 AND $2`,
      [mskStart, mskEnd]
    );
    const limitsReached = limitsRes.rows[0].count || 0;

    // 7. Поведенческие предложения и клики тарифов
    const shownRes = await client.query(
      `SELECT COUNT(*)::int AS count 
       FROM analytics_events 
       WHERE event_name = 'star_payment_option_shown' 
         AND created_at BETWEEN $1 AND $2`,
      [mskStart, mskEnd]
    );
    const tariffsShown = shownRes.rows[0].count || 0;

    const clickedRes = await client.query(
      `SELECT COUNT(*)::int AS count 
       FROM analytics_events 
       WHERE event_name = 'subscription_plan_clicked' 
         AND created_at BETWEEN $1 AND $2`,
      [mskStart, mskEnd]
    );
    const tariffsClicked = clickedRes.rows[0].count || 0;

    // 8. Финансовый воронка
    const payStartedRes = await client.query(
      `SELECT COUNT(*)::int AS count 
       FROM analytics_events 
       WHERE event_name IN ('payment_method_selected', 'star_invoice_created') 
         AND created_at BETWEEN $1 AND $2`,
      [mskStart, mskEnd]
    );
    const paymentsStarted = payStartedRes.rows[0].count || 0;

    const payCompletedRes = await client.query(
      `SELECT COUNT(*)::int AS count 
       FROM payments 
       WHERE payment_status = 'completed' 
         AND paid_at BETWEEN $1 AND $2`,
      [mskStart, mskEnd]
    );
    const paymentsCompleted = payCompletedRes.rows[0].count || 0;

    // 9. Выручка RUB (в копейках) и XTR (Stars)
    const revRubRes = await client.query(
      `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS sum 
       FROM payments 
       WHERE payment_status = 'completed' 
         AND currency = 'RUB' 
         AND paid_at BETWEEN $1 AND $2`,
      [mskStart, mskEnd]
    );
    const revenueRub = revRubRes.rows[0].sum || 0;

    const revXtrRes = await client.query(
      `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS sum 
       FROM payments 
       WHERE payment_status = 'completed' 
         AND currency = 'XTR' 
         AND paid_at BETWEEN $1 AND $2`,
      [mskStart, mskEnd]
    );
    const revenueXtr = revXtrRes.rows[0].sum || 0;

    // 10. Вставка агрегированных данных за день
    await client.query(
      `INSERT INTO analytics_daily (
        day, dau, wau, mau, registrations, downloads_total, downloads_from_cache, downloads_new,
        limits_reached, tariffs_shown, tariffs_clicked, payments_started, payments_completed,
        revenue_rub_minor, revenue_xtr, updated_at, aggregation_version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, timezone('utc', now()), 1)
      ON CONFLICT (day) DO UPDATE
      SET dau = EXCLUDED.dau,
          wau = EXCLUDED.wau,
          mau = EXCLUDED.mau,
          registrations = EXCLUDED.registrations,
          downloads_total = EXCLUDED.downloads_total,
          downloads_from_cache = EXCLUDED.downloads_from_cache,
          downloads_new = EXCLUDED.downloads_new,
          limits_reached = EXCLUDED.limits_reached,
          tariffs_shown = EXCLUDED.tariffs_shown,
          tariffs_clicked = EXCLUDED.tariffs_clicked,
          payments_started = EXCLUDED.payments_started,
          payments_completed = EXCLUDED.payments_completed,
          revenue_rub_minor = EXCLUDED.revenue_rub_minor,
          revenue_xtr = EXCLUDED.revenue_xtr,
          updated_at = timezone('utc', now()),
          aggregation_version = analytics_daily.aggregation_version + 1`,
      [
        day, dau, wau, mau, registrations, downloadsTotal, cacheHits, downloadsNew,
        limitsReached, tariffsShown, tariffsClicked, paymentsStarted, paymentsCompleted,
        revenueRub, revenueXtr
      ]
    );

    // 11. Заполнение детальной пользовательской активности за эти сутки
    await client.query(
      `WITH active_users AS (
         SELECT DISTINCT user_id FROM public.analytics_events WHERE created_at BETWEEN $2 AND $3
         UNION
         SELECT DISTINCT user_id FROM public.downloads_log WHERE downloaded_at BETWEEN $2 AND $3
       )
       INSERT INTO analytics_user_daily (day, user_id, downloads_count, searches_count, limits_reached_count, primary_source)
       SELECT 
         $1::date,
         au.user_id,
         COALESCE((SELECT COUNT(*) FROM downloads_log dl WHERE dl.user_id = au.user_id AND dl.downloaded_at BETWEEN $2 AND $3), 0)::int,
         COALESCE((SELECT COUNT(*) FROM analytics_events ae WHERE ae.user_id = au.user_id AND ae.event_name = 'track_search_started' AND ae.created_at BETWEEN $2 AND $3), 0)::int,
         COALESCE((SELECT COUNT(*) FROM analytics_events ae WHERE ae.user_id = au.user_id AND ae.event_name = 'daily_limit_reached' AND ae.created_at BETWEEN $2 AND $3), 0)::int,
         u.referral_source
       FROM active_users au
       JOIN users u ON u.id = au.user_id
       ON CONFLICT (day, user_id) DO UPDATE
       SET downloads_count = EXCLUDED.downloads_count,
           searches_count = EXCLUDED.searches_count,
           limits_reached_count = EXCLUDED.limits_reached_count,
           primary_source = EXCLUDED.primary_source`,
      [day, mskStart, mskEnd]
    );

    await client.query('COMMIT');
    console.log(`[Analytics/Aggregate] Успешно завершено за день ${day}.`);
  } catch (e) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (_rollbackErr) {}
    }
    console.error(`[Analytics/Aggregate] Ошибка агрегации за день ${day}:`, e.message);
    throw e;
  } finally {
    if (client) {
      client.release();
    }
  }
}

export async function backfillMissingDays() {
  const today = new Date();
  console.log('[Analytics/Backfill] Проверка пропущенных дней агрегации за последние 7 суток...');
  for (let i = 1; i <= 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const dateStr = d.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
    
    try {
      const { rows } = await query('SELECT 1 FROM analytics_daily WHERE day = $1', [dateStr]);
      if (rows.length === 0) {
        console.log(`[Startup/Backfill] Обнаружен пропущенный день: ${dateStr}. Запуск агрегации...`);
        await aggregateDailyStats(dateStr);
      }
    } catch (e) {
      console.error(`[Startup/Backfill] Ошибка проверки/агрегации за ${dateStr}:`, e.message);
    }
  }
  console.log('[Analytics/Backfill] Проверка завершена.');
}

export async function getLanguageDistribution() {
  const sql = `
    SELECT
      COALESCE(language_code, 'NULL') AS language_code,
      COALESCE(language_source, 'NULL') AS language_source,
      COUNT(*)::int AS count
    FROM users
    GROUP BY 1, 2
    ORDER BY count DESC
  `;
  const { rows } = await query(sql);
  return rows;
}

export async function getLanguageHistoryForUser(userId) {
  const sql = `
    SELECT * FROM language_history
    WHERE user_id = $1
    ORDER BY created_at DESC
  `;
  const { rows } = await query(sql, [userId]);
  return rows;
}

export async function setUserLanguageByAdmin(userId, langCode, adminId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Получаем текущие данные пользователя
    const userRes = await client.query('SELECT language_code, language_source FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];
    if (!user) {
      throw new Error('Пользователь не найден.');
    }
    
    const prevLang = user.language_code || 'ru';
    const prevSource = user.language_source || 'legacy_default';
    
    // Обновляем пользователя
    await client.query(
      `UPDATE users 
       SET language_code = $2, 
           language_source = 'admin_changed', 
           language_updated_at = NOW() 
       WHERE id = $1`,
      [userId, langCode]
    );
    
    // Записываем историю
    await client.query(
      `INSERT INTO language_history 
       (user_id, previous_language, new_language, previous_source, new_source, changed_by_type, changed_by_user_id)
       VALUES ($1, $2, $3, $4, 'admin_changed', 'admin', $5)`,
      [userId, prevLang, langCode, prevSource, adminId]
    );
    
    await client.query('COMMIT');
    userCache.delete(String(userId));
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getBroadcastTaskStats(broadcastId) {
  // 1. Сводка доставки
  const deliveryRes = await query(
    `SELECT status, COUNT(*)::int AS count FROM broadcast_log WHERE broadcast_id = $1 GROUP BY status`,
    [broadcastId]
  );
  const delivery = { sent: 0, failed: 0, blocked: 0, pending: 0 };
  for (const row of deliveryRes.rows) {
    if (row.status === 'sent') delivery.sent = row.count;
    else if (row.status === 'failed') delivery.failed = row.count;
    else if (row.status === 'blocked') delivery.blocked = row.count;
    else if (row.status === 'pending') delivery.pending = row.count;
  }
  delivery.total = delivery.sent + delivery.failed + delivery.blocked + delivery.pending;

  // 2. Доставка по языкам
  const langRes = await query(
    `SELECT delivered_language, status, COUNT(*)::int AS count 
     FROM broadcast_log 
     WHERE broadcast_id = $1 
     GROUP BY delivered_language, status`,
    [broadcastId]
  );
  const languages = {};
  for (const row of langRes.rows) {
    const lang = row.delivered_language || 'unknown';
    if (!languages[lang]) languages[lang] = { sent: 0, failed: 0, blocked: 0, pending: 0 };
    if (row.status === 'sent') languages[lang].sent = row.count;
    else if (row.status === 'failed') languages[lang].failed = row.count;
    else if (row.status === 'blocked') languages[lang].blocked = row.count;
    else if (row.status === 'pending') languages[lang].pending = row.count;
  }

  // 3. Клики по кнопкам
  const clickRes = await query(
    `SELECT button_index, COUNT(*)::int AS total, COUNT(DISTINCT user_id)::int AS unique 
     FROM broadcast_clicks 
     WHERE campaign_id = $1 
     GROUP BY button_index 
     ORDER BY button_index ASC`,
    [broadcastId]
  );
  const clicks = clickRes.rows;

  // 4. Просмотры тарифов (Upgrade) в течение 24 часов
  const upgradeRes = await query(
    `SELECT COUNT(DISTINCT e.user_id)::int AS count
     FROM analytics_events e
     JOIN broadcast_log l ON e.user_id = l.user_id
     WHERE l.broadcast_id = $1 
       AND l.status = 'sent'
       AND e.event_name = 'star_payment_option_shown'
       AND e.created_at >= l.sent_at 
       AND e.created_at <= l.sent_at + INTERVAL '24 hours'`,
    [broadcastId]
  );
  const upgradesAfterSent = upgradeRes.rows[0]?.count || 0;

  // 5. Оплаты (Payments) в течение 24 часов
  const paymentRes = await query(
    `SELECT COUNT(DISTINCT p.user_id)::int AS count
     FROM payments p
     JOIN broadcast_log l ON p.user_id = l.user_id
     WHERE l.broadcast_id = $1 
       AND l.status = 'sent'
       AND p.payment_status = 'completed'
       AND p.paid_at BETWEEN l.sent_at AND l.sent_at + INTERVAL '24 hours'`,
    [broadcastId]
  );
  const paymentsAfterSent = paymentRes.rows[0]?.count || 0;

  return {
    delivery,
    languages,
    clicks,
    upgradesAfterSent,
    paymentsAfterSent
  };
}

export async function getExcelAnalyticsData(startDate, endDate) {
  const mskStart = `${startDate}T00:00:00+03:00`;
  const mskEnd = `${endDate}T23:59:59.999+03:00`;

  // 1. Summary from analytics_daily & payments
  const totalUsersRes = await query(`SELECT COUNT(*)::int FROM users`);
  const totalUsers = totalUsersRes.rows[0].count || 0;

  const newUsersRes = await query(`SELECT COUNT(*)::int FROM users WHERE created_at BETWEEN $1 AND $2`, [mskStart, mskEnd]);
  const newUsers = newUsersRes.rows[0].count || 0;

  const dailyAggRes = await query(
    `SELECT 
       COALESCE(AVG(dau), 0)::int AS avg_dau,
       COALESCE(AVG(wau), 0)::int AS avg_wau,
       COALESCE(AVG(mau), 0)::int AS avg_mau,
       COALESCE(SUM(downloads_total), 0)::int AS total_downloads
     FROM analytics_daily
     WHERE day BETWEEN $1 AND $2`,
    [startDate, endDate]
  );
  const dailyAgg = dailyAggRes.rows[0];

  const revRubRes = await query(
    `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS sum, COUNT(*)::int AS count
     FROM payments
     WHERE payment_status = 'completed' AND currency = 'RUB' AND paid_at BETWEEN $1 AND $2`,
    [mskStart, mskEnd]
  );
  const revenueRub = (revRubRes.rows[0].sum || 0) / 100.0;
  const paymentsRubCount = revRubRes.rows[0].count || 0;

  const revStarsRes = await query(
    `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS sum, COUNT(*)::int AS count
     FROM payments
     WHERE payment_status = 'completed' AND currency = 'XTR' AND paid_at BETWEEN $1 AND $2`,
    [mskStart, mskEnd]
  );
  const revenueStars = revStarsRes.rows[0].sum || 0;
  const paymentsStarsCount = revStarsRes.rows[0].count || 0;

  const totalPayments = paymentsRubCount + paymentsStarsCount;

  // 2. Funnel
  const searchedUsersRes = await query(
    `SELECT COUNT(DISTINCT user_id)::int AS count FROM analytics_events 
     WHERE event_name = 'track_search_started' AND created_at BETWEEN $1 AND $2`,
    [mskStart, mskEnd]
  );
  const searchedUsers = searchedUsersRes.rows[0].count || 0;

  const downloadedUsersRes = await query(
    `SELECT COUNT(DISTINCT user_id)::int AS count FROM downloads_log 
     WHERE downloaded_at BETWEEN $1 AND $2`,
    [mskStart, mskEnd]
  );
  const downloadedUsers = downloadedUsersRes.rows[0].count || 0;

  const reachedLimitUsersRes = await query(
    `SELECT COUNT(DISTINCT user_id)::int AS count FROM analytics_events 
     WHERE event_name = 'daily_limit_reached' AND created_at BETWEEN $1 AND $2`,
    [mskStart, mskEnd]
  );
  const reachedLimitUsers = reachedLimitUsersRes.rows[0].count || 0;

  const openedTariffsUsersRes = await query(
    `SELECT COUNT(DISTINCT user_id)::int AS count FROM analytics_events 
     WHERE event_name = 'star_payment_option_shown' AND created_at BETWEEN $1 AND $2`,
    [mskStart, mskEnd]
  );
  const openedTariffsUsers = openedTariffsUsersRes.rows[0].count || 0;

  const startedPaymentUsersRes = await query(
    `SELECT COUNT(DISTINCT user_id)::int AS count FROM analytics_events 
     WHERE event_name IN ('payment_method_selected', 'star_invoice_created') AND created_at BETWEEN $1 AND $2`,
    [mskStart, mskEnd]
  );
  const startedPaymentUsers = startedPaymentUsersRes.rows[0].count || 0;

  const paidUsersRes = await query(
    `SELECT COUNT(DISTINCT user_id)::int AS count FROM payments 
     WHERE payment_status = 'completed' AND paid_at BETWEEN $1 AND $2`,
    [mskStart, mskEnd]
  );
  const paidUsers = paidUsersRes.rows[0].count || 0;

  const funnel = [
    { stage: 'Открыли бота', count: totalUsers },
    { stage: 'Искали треки', count: searchedUsers },
    { stage: 'Скачивали', count: downloadedUsers },
    { stage: 'Достигли лимита', count: reachedLimitUsers },
    { stage: 'Открыли тарифы', count: openedTariffsUsers },
    { stage: 'Начали оплату', count: startedPaymentUsers },
    { stage: 'Оплатили', count: paidUsers }
  ];

  // 3. Tariffs (Plus, Pro, Unlimited) daily counts
  const tariffsRes = await query(
    `SELECT 
       paid_at::date::text AS day,
       COUNT(*) FILTER (WHERE plan = 'plus')::int AS plus,
       COUNT(*) FILTER (WHERE plan = 'pro')::int AS pro,
       COUNT(*) FILTER (WHERE plan = 'unlim')::int AS unlim
     FROM payments
     WHERE payment_status = 'completed' AND paid_at BETWEEN $1 AND $2
     GROUP BY paid_at::date
     ORDER BY day ASC`,
    [mskStart, mskEnd]
  );
  const tariffs = tariffsRes.rows;

  // 4. Payments list
  const paymentsRes = await query(
    `SELECT 
       paid_at::date::text AS date,
       payment_method AS method,
       currency,
       CASE WHEN currency = 'RUB' THEN amount_minor / 100.0 ELSE amount_minor END AS amount,
       plan,
       COUNT(*)::int AS count
     FROM payments
     WHERE payment_status = 'completed' AND paid_at BETWEEN $1 AND $2
     GROUP BY paid_at::date, payment_method, currency, amount_minor, plan
     ORDER BY date DESC`,
    [mskStart, mskEnd]
  );
  const paymentsList = paymentsRes.rows;

  // 5. Campaigns (Рассылки)
  const campaignsRes = await query(
    `SELECT 
       t.id::int AS id,
       t.campaign_name AS name,
       t.campaign_tag AS tag,
       t.scheduled_at::date::text AS date,
       (
         SELECT COUNT(*) 
         FROM users u 
         WHERE u.active = TRUE AND u.can_receive_broadcasts = TRUE
           AND (
             t.target_audience = 'all' OR
             t.target_audience = 'all_users' OR
             (t.target_audience = 'free_users' AND (u.premium_until IS NULL OR u.premium_until < NOW() OR (u.premium_limit <= COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3) AND u.premium_limit IS NOT NULL))) OR
             (t.target_audience = 'premium_users' AND (u.premium_until IS NOT NULL AND u.premium_until >= NOW() AND (u.premium_limit > COALESCE((SELECT value::int FROM app_settings WHERE key = 'daily_limit_free'), 3) OR u.premium_limit IS NULL)))
           )
       )::int AS recipients,
       (SELECT COUNT(*) FROM broadcast_log WHERE broadcast_id = t.id AND status = 'sent')::int AS delivered,
       COALESCE((SELECT COUNT(*)::int FROM broadcast_clicks WHERE campaign_id = t.id), 0) AS clicks,
       COALESCE((
         SELECT COUNT(DISTINCT p.user_id)::int
         FROM broadcast_log l
         JOIN payments p ON p.user_id = l.user_id AND p.payment_status = 'completed'
         WHERE l.broadcast_id = t.id AND l.status = 'sent' AND p.paid_at BETWEEN l.sent_at AND (l.sent_at + interval '24 hours')
       ), 0) AS conversions_24h
     FROM broadcast_tasks t
     WHERE t.scheduled_at BETWEEN $1 AND $2
     ORDER BY t.scheduled_at DESC`,
    [mskStart, mskEnd]
  );
  const campaigns = campaignsRes.rows;

  // 6. Language Segments
  const languagesRes = await query(
    `WITH user_segments AS (
       SELECT 
         id,
         CASE 
           WHEN language_source IN ('user_selected', 'admin_changed') THEN 
             CASE WHEN language_code IN ('ru', 'en') THEN UPPER(language_code) ELSE 'UNKNOWN' END
           WHEN COALESCE(language_source, 'legacy_default') = 'legacy_default' THEN 
             CASE WHEN language_code IN ('ru', 'en') THEN UPPER(language_code) ELSE 'UNKNOWN' END
           WHEN language_source = 'telegram_auto' THEN 
             CASE 
               WHEN language_code IN ('ru', 'en') AND (
                 telegram_language_code IS NULL OR 
                 LOWER(SPLIT_PART(telegram_language_code, '-', 1)) IN ('ru', 'uk', 'be', 'kk', 'en')
               ) THEN UPPER(language_code)
               ELSE 'UNKNOWN' 
             END
           ELSE 'UNKNOWN'
         END AS segment,
         last_active,
         (SELECT COUNT(*) FROM payments p WHERE p.user_id = u.id AND p.payment_status = 'completed' AND p.paid_at BETWEEN $1 AND $2) AS has_payment
       FROM users u
     )
     SELECT 
       segment AS language,
       COUNT(*)::int AS users,
       COUNT(*) FILTER (WHERE last_active BETWEEN $1 AND $2)::int AS active,
       COUNT(*) FILTER (WHERE has_payment > 0)::int AS payments
     FROM user_segments
     GROUP BY segment`,
    [mskStart, mskEnd]
  );
  const languages = languagesRes.rows;

  // 7. Daily Stats
  const dailyStatsRes = await query(
    `SELECT 
       day::text AS day,
       dau, wau, mau, registrations,
       downloads_total AS downloads,
       limits_reached AS limits,
       (revenue_rub_minor / 100.0) AS revenue_rub,
       revenue_xtr AS revenue_stars
     FROM analytics_daily
     WHERE day BETWEEN $1 AND $2
     ORDER BY day ASC`,
    [startDate, endDate]
  );
  const dailyStats = dailyStatsRes.rows;

  return {
    startDate,
    endDate,
    summary: {
      total_users: totalUsers,
      new_users: newUsers,
      avg_dau: Math.round(dailyAgg.avg_dau),
      avg_wau: Math.round(dailyAgg.avg_wau),
      avg_mau: Math.round(dailyAgg.avg_mau),
      total_downloads: dailyAgg.total_downloads,
      revenue_rub: revenueRub,
      revenue_stars: revenueStars,
      payments_count: totalPayments
    },
    funnel,
    tariffs,
    payments: paymentsList,
    campaigns,
    languages,
    daily_stats: dailyStats
  };
}

export async function getPeriodComparisonData(startA, endA, startB, endB) {
  const getMetrics = async (start, end) => {
    const mskStart = `${start}T00:00:00+03:00`;
    const mskEnd = `${end}T23:59:59.999+03:00`;

    // 1. Registrations
    const regRes = await query(`SELECT COUNT(*)::int FROM users WHERE created_at BETWEEN $1 AND $2`, [mskStart, mskEnd]);
    const registrations = regRes.rows[0].count || 0;

    // 2. Daily metrics from analytics_daily
    const dailyRes = await query(
      `SELECT 
         COALESCE(AVG(dau), 0)::int AS dau,
         COALESCE(AVG(wau), 0)::int AS wau,
         COALESCE(AVG(mau), 0)::int AS mau,
         COALESCE(SUM(downloads_total), 0)::int AS downloads,
         COALESCE(SUM(limits_reached), 0)::int AS limits_reached,
         COALESCE(SUM(tariffs_shown), 0)::int AS tariffs_shown,
         COALESCE(SUM(tariffs_clicked), 0)::int AS tariffs_clicked,
         COALESCE(SUM(payments_started), 0)::int AS payments_started,
         COALESCE(SUM(payments_completed), 0)::int AS payments_completed
       FROM public.analytics_daily
       WHERE day BETWEEN $1 AND $2`,
      [start, end]
    );
    const daily = dailyRes.rows[0];

    // 3. Financials
    const rubRes = await query(
      `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS sum FROM payments 
       WHERE payment_status = 'completed' AND currency = 'RUB' AND paid_at BETWEEN $1 AND $2`,
      [mskStart, mskEnd]
    );
    const revRub = (rubRes.rows[0].sum || 0) / 100.0;

    const xtrRes = await query(
      `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS sum FROM payments 
       WHERE payment_status = 'completed' AND currency = 'XTR' AND paid_at BETWEEN $1 AND $2`,
      [mskStart, mskEnd]
    );
    const revStars = xtrRes.rows[0].sum || 0;

    const payingUsersRes = await query(
      `SELECT COUNT(DISTINCT user_id)::int FROM payments 
       WHERE payment_status = 'completed' AND paid_at BETWEEN $1 AND $2`,
      [mskStart, mskEnd]
    );
    const payingUsers = payingUsersRes.rows[0].count || 0;

    const conversion = registrations > 0 ? (payingUsers / registrations * 100) : 0.0;

    return {
      registrations,
      dau: daily.dau,
      wau: daily.wau,
      mau: daily.mau,
      downloads: daily.downloads,
      limits_reached: daily.limits_reached,
      tariffs_shown: daily.tariffs_shown,
      tariffs_clicked: daily.tariffs_clicked,
      payments_started: daily.payments_started,
      payments_completed: daily.payments_completed,
      revenue_rub: revRub,
      revenue_stars: revStars,
      paying_users: payingUsers,
      conversion
    };
  };

  const metricsA = await getMetrics(startA, endA);
  const metricsB = await getMetrics(startB, endB);

  // Compute diffs
  const keys = Object.keys(metricsA);
  const diffs = {};
  keys.forEach(k => {
    const valA = metricsA[k];
    const valB = metricsB[k];
    const diffVal = valA - valB;
    const pct = valB > 0 ? (diffVal / valB * 100) : 0;
    diffs[k] = {
      valA,
      valB,
      diff: diffVal,
      pct: pct
    };
  });

  return diffs;
}

export async function getCohortRetentionData() {
  const sql = `
    WITH cohorts AS (
      SELECT 
        id AS user_id,
        created_at::date AS reg_date,
        DATE_TRUNC('month', created_at)::date AS cohort_month
      FROM users
    ),
    retention AS (
      SELECT 
        c.cohort_month,
        COUNT(DISTINCT c.user_id)::int AS cohort_size,
        COUNT(DISTINCT CASE WHEN CURRENT_DATE >= c.reg_date + 1 THEN c.user_id END)::int AS day_1_eligible,
        COUNT(DISTINCT CASE WHEN CURRENT_DATE >= c.reg_date + 7 THEN c.user_id END)::int AS day_7_eligible,
        COUNT(DISTINCT CASE WHEN CURRENT_DATE >= c.reg_date + 30 THEN c.user_id END)::int AS day_30_eligible,
        COUNT(DISTINCT CASE WHEN CURRENT_DATE >= c.reg_date + 90 THEN c.user_id END)::int AS day_90_eligible,
        COUNT(DISTINCT CASE WHEN aud.day = c.reg_date + 1 THEN c.user_id END)::int AS day_1_active,
        COUNT(DISTINCT CASE WHEN aud.day = c.reg_date + 7 THEN c.user_id END)::int AS day_7_active,
        COUNT(DISTINCT CASE WHEN aud.day = c.reg_date + 30 THEN c.user_id END)::int AS day_30_active,
        COUNT(DISTINCT CASE WHEN aud.day = c.reg_date + 90 THEN c.user_id END)::int AS day_90_active
      FROM cohorts c
      LEFT JOIN analytics_user_daily aud ON aud.user_id = c.user_id
      GROUP BY c.cohort_month
    )
    SELECT 
      TO_CHAR(r.cohort_month, 'YYYY-MM') AS cohort,
      r.cohort_size AS size,
      r.day_1_eligible,
      r.day_7_eligible,
      r.day_30_eligible,
      r.day_90_eligible,
      r.day_1_active,
      r.day_7_active,
      r.day_30_active,
      r.day_90_active
    FROM retention r
    ORDER BY r.cohort_month DESC
    LIMIT 12
  `;
  const { rows } = await query(sql);
  return rows;
}

export async function getRevenueDashboardData(startDate, endDate) {
  const rateResult = await query(
    `SELECT COALESCE(
       (SELECT value::numeric FROM app_settings WHERE key = 'xtr_rub_rate'),
       2.00
     )::float8 AS rate`
  );
  const rate = Number(rateResult.rows[0]?.rate ?? 2);

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
  const mskStart = `${startDate}T00:00:00+03:00`;
  const mskEnd = `${endDate}T23:59:59.999+03:00`;
  const todayMskStart = `${todayStr}T00:00:00+03:00`;
  const todayMskEnd = `${todayStr}T23:59:59.999+03:00`;

  // 1. Today's successful payments
  const todayRes = await query(
    `SELECT 
       COUNT(*)::int AS count,
       COALESCE(SUM(amount_minor) FILTER (WHERE currency = 'RUB'), 0) / 100.0 AS rub,
       COALESCE(SUM(amount_minor) FILTER (WHERE currency = 'XTR'), 0) AS stars
     FROM payments
     WHERE payment_status = 'completed' AND paid_at BETWEEN $1 AND $2`,
    [todayMskStart, todayMskEnd]
  );
  const today = todayRes.rows[0];

  // 2. MRR (last 30 days rolling)
  const rollingStart = new Date(Date.now() - 30 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' }) + 'T00:00:00+03:00';
  const mrrRes = await query(
    `SELECT 
       COALESCE(SUM(amount_minor) FILTER (WHERE currency = 'RUB'), 0) / 100.0 AS rub,
       COALESCE(SUM(amount_minor) FILTER (WHERE currency = 'XTR'), 0) AS stars
     FROM payments
     WHERE payment_status = 'completed' AND paid_at >= $1`,
    [rollingStart]
  );
  const mrrData = mrrRes.rows[0];
  const mrr = mrrData.rub + mrrData.stars * rate;

  // 3. ARPPU & conversion for selected period
  const revenueRes = await query(
    `SELECT 
       COALESCE(SUM(amount_minor) FILTER (WHERE currency = 'RUB'), 0) / 100.0 AS rub,
       COALESCE(SUM(amount_minor) FILTER (WHERE currency = 'XTR'), 0) AS stars,
       COUNT(DISTINCT user_id)::int AS paying_users
     FROM payments
     WHERE payment_status = 'completed' AND paid_at BETWEEN $1 AND $2`,
    [mskStart, mskEnd]
  );
  const rev = revenueRes.rows[0];
  const totalRevenueRubEquivalent = rev.rub + rev.stars * rate;
  const arppu = rev.paying_users > 0 ? (totalRevenueRubEquivalent / rev.paying_users) : 0;

  // Conversion Free -> Paid (users registered in period who paid)
  const regUsersRes = await query(`SELECT COUNT(*)::int FROM users WHERE created_at BETWEEN $1 AND $2`, [mskStart, mskEnd]);
  const totalRegistered = regUsersRes.rows[0].count || 0;

  const payingRegUsersRes = await query(
    `SELECT COUNT(DISTINCT u.id)::int 
     FROM users u
     JOIN payments p ON p.user_id = u.id AND p.payment_status = 'completed'
     WHERE u.created_at BETWEEN $1 AND $2`,
    [mskStart, mskEnd]
  );
  const payingRegistered = payingRegUsersRes.rows[0].count || 0;
  const conversionFreePaid = totalRegistered > 0 ? (payingRegistered / totalRegistered * 100) : 0;

  // 4. Breakdown of payments
  const breakdownRes = await query(
    `SELECT 
       payment_method AS method,
       currency,
       COUNT(*)::int AS count,
       SUM(amount_minor) AS sum_minor
     FROM payments
     WHERE payment_status = 'completed' AND paid_at BETWEEN $1 AND $2
     GROUP BY payment_method, currency
     ORDER BY count DESC`,
    [mskStart, mskEnd]
  );
  
  const breakdown = breakdownRes.rows.map(row => {
    const sum = row.currency === 'RUB' ? row.sum_minor / 100.0 : Number(row.sum_minor);
    const rubEquivalent = row.currency === 'RUB' ? sum : sum * rate;
    return {
      method: row.method,
      currency: row.currency,
      count: row.count,
      sum,
      rubEquivalent
    };
  });

  return {
    today: {
      count: today.count,
      rub: today.rub,
      stars: today.stars,
      totalRubEquivalent: today.rub + today.stars * rate
    },
    mrr,
    arppu,
    paying_users: rev.paying_users,
    conversionFreePaid,
    totalRegistered,
    totalRevenueRubEquivalent,
    breakdown,
    rate
  };
}

export async function getAIRecommendationsData() {
  const getMoscowDateStrForOffset = (offsetDays) => {
    const d = new Date(Date.now() - offsetDays * 86400000);
    return d.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
  };

  const endA = getMoscowDateStrForOffset(0);
  const startA = getMoscowDateStrForOffset(13);
  const endB = getMoscowDateStrForOffset(14);
  const startB = getMoscowDateStrForOffset(27);

  const queryMetrics = async (start, end) => {
    const res = await query(
      `SELECT 
         COALESCE(AVG(dau), 0)::float AS avg_dau,
         COALESCE(SUM(downloads_total), 0)::float AS total_downloads,
         COALESCE(SUM(limits_reached), 0)::float AS total_limits,
         COALESCE(SUM(revenue_rub_minor), 0)::float / 100.0 AS revenue_rub,
         COALESCE(SUM(revenue_xtr), 0)::float AS revenue_stars
       FROM public.analytics_daily
       WHERE day BETWEEN $1 AND $2`,
      [start, end]
    );
    return res.rows[0];
  };

  const metricsA = await queryMetrics(startA, endA);
  const metricsB = await queryMetrics(startB, endB);

  // Default rates config
  const { getSetting } = await import('./services/settingsManager.js');
  const rate = parseFloat(getSetting('xtr_rub_rate') || '2.00');

  const revA = metricsA.revenue_rub + metricsA.revenue_stars * rate;
  const revB = metricsB.revenue_rub + metricsB.revenue_stars * rate;

  const dauChange = metricsB.avg_dau > 0 ? ((metricsA.avg_dau - metricsB.avg_dau) / metricsB.avg_dau * 100) : 0;
  const downloadsChange = metricsB.total_downloads > 0 ? ((metricsA.total_downloads - metricsB.total_downloads) / metricsB.total_downloads * 100) : 0;
  const limitsChange = metricsB.total_limits > 0 ? ((metricsA.total_limits - metricsB.total_limits) / metricsB.total_limits * 100) : 0;
  const revenueChange = revB > 0 ? ((revA - revB) / revB * 100) : 0;

  const recommendations = [];

  if (dauChange < -15) {
    recommendations.push({
      type: 'warning',
      metric: 'DAU',
      title: `Активность пользователей снизилась на ${Math.abs(dauChange).toFixed(1)}% за последние 14 дней.`,
      text: 'Рекомендуется проверить последние изменения в боте (например, новые ограничения или ошибки скачивания) и запустить рассылку-напоминание для возврата неактивных пользователей.'
    });
  }

  // Active users reached limit percentage
  const activeUsersRes = await query(
    `SELECT COUNT(DISTINCT user_id)::int FROM analytics_user_daily 
     WHERE day BETWEEN $1 AND $2`,
    [startA, endA]
  );
  const activeUsersCount = activeUsersRes.rows[0].count || 1;
  const limitReachedUsersRes = await query(
    `SELECT COUNT(DISTINCT user_id)::int FROM analytics_user_daily 
     WHERE day BETWEEN $1 AND $2 AND limits_reached_count > 0`,
    [startA, endA]
  );
  const limitReachedUsersCount = limitReachedUsersRes.rows[0].count || 0;
  const limitReachedPct = (limitReachedUsersCount / activeUsersCount) * 100;

  if (limitReachedPct > 20) {
    recommendations.push({
      type: 'info',
      metric: 'LIMITS',
      title: `За последние 14 дней ${limitReachedPct.toFixed(1)}% активных пользователей уперлись в лимит Free.`,
      text: 'Это отличная возможность для монетизации! Рекомендуется протестировать скидки на тариф Plus или запустить акционную рассылку со специальным предложением.'
    });
  } else if (limitsChange > 15) {
    recommendations.push({
      type: 'info',
      metric: 'LIMITS',
      title: `Количество достижений лимитов выросло на ${limitsChange.toFixed(1)}%.`,
      text: 'Спрос на скачивания растет. Предложите пользователям тарифы Plus или Pro с расширенными лимитами, запустив таргетированную рассылку.'
    });
  }

  if (revenueChange < -10) {
    recommendations.push({
      type: 'warning',
      metric: 'REVENUE',
      title: `Выручка снизилась на ${Math.abs(revenueChange).toFixed(1)}% по сравнению с предыдущими 14 днями.`,
      text: 'Рекомендуется проверить работу платежных шлюзов (Т-Банк / СБП / Stars) на предмет сбоев и предложить временную скидку на тариф Pro для стимуляции оплат.'
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      type: 'success',
      metric: 'OK',
      title: 'Все ключевые метрики находятся в пределах нормы.',
      text: 'DAU, лимиты и выручка стабильны. Рекомендуется продолжать привлекать трафик и оптимизировать конверсии.'
    });
  }

  return {
    dauChange,
    downloadsChange,
    limitsChange,
    revenueChange,
    recommendations
  };
}

export const REQUIRED_SCHEMA = Object.freeze({
  broadcast_tasks: ['id', 'message', 'file_id', 'target_audience', 'disable_notification', 'scheduled_at', 'status', 'report', 'created_at', 'completed_at', 'keyboard', 'disable_web_page_preview', 'file_mime_type', 'started_at', 'target_languages', 'unknown_language_policy', 'messages_json', 'language_source_filter', 'message_version', 'broadcast_type', 'campaign_tag', 'campaign_name', 'fallback_language', 'launch_confirmed_at', 'launch_confirmed_by'],
  broadcast_log: ['id', 'broadcast_id', 'user_id', 'sent_at', 'audience_language_segment', 'delivered_language', 'status'],
  broadcast_clicks: ['id', 'campaign_id', 'user_id', 'button_index', 'clicked_at', 'user_agent', 'language_code'],
  language_history: ['id', 'user_id', 'previous_language', 'new_language', 'previous_source', 'new_source', 'changed_by_type', 'changed_by_user_id', 'created_at'],
  analytics_events: ['id', 'user_id', 'event_name', 'event_category', 'event_data', 'session_id', 'event_origin', 'acquisition_source', 'event_source', 'placement', 'campaign_id', 'language_code', 'deduplication_key', 'created_at'],
  analytics_daily: ['day', 'dau', 'wau', 'mau', 'registrations', 'downloads_total', 'downloads_from_cache', 'downloads_new', 'limits_reached', 'tariffs_shown', 'tariffs_clicked', 'payments_started', 'payments_completed', 'revenue_rub_minor', 'revenue_xtr', 'updated_at', 'aggregation_version'],
  analytics_user_daily: ['day', 'user_id', 'downloads_count', 'searches_count', 'limits_reached_count', 'primary_source'],
  payments: ['id', 'user_id', 'plan', 'amount_minor', 'currency', 'payment_method', 'payment_status', 'telegram_payment_charge_id', 'provider_payment_charge_id', 'invoice_payload', 'is_recurring', 'is_first_recurring', 'subscription_expiration_date', 'period_days', 'comment', 'metadata', 'created_at', 'paid_at'],
  users: ['id', 'username', 'first_name', 'active', 'can_receive_broadcasts', 'downloads_today', 'total_downloads', 'tracks_today', 'premium_limit', 'premium_until', 'created_at', 'last_active', 'last_reset_date', 'lang', 'telegram_language_code', 'language_code', 'language_source', 'language_updated_at', 'notified_about_expiration', 'notified_exp_3d', 'notified_exp_1d', 'notified_exp_0d'],
  app_settings: ['key', 'value']
});

export const REQUIRED_SCHEMA_VERSION = 10;

export async function checkSchemaPreflight({ throwOnMissing = true } = {}) {
  const tableNames = Object.keys(REQUIRED_SCHEMA);
  const requiredColumnCount = Object.values(REQUIRED_SCHEMA).reduce((sum, columns) => sum + columns.length, 0);

  console.log('[Schema Check] Running schema contract preflight...');
  const res = await query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])`,
    [tableNames]
  );

  const actualSchema = new Map();
  for (const row of res.rows) {
    if (!actualSchema.has(row.table_name)) actualSchema.set(row.table_name, new Set());
    actualSchema.get(row.table_name).add(row.column_name);
  }

  const missingTables = [];
  const missingColumns = [];
  for (const [table, columns] of Object.entries(REQUIRED_SCHEMA)) {
    const actualColumns = actualSchema.get(table);
    if (!actualColumns) missingTables.push(table);
    for (const column of columns) {
      if (!actualColumns?.has(column)) missingColumns.push(`${table}.${column}`);
    }
  }

  let actualSchemaVersion = null;
  const appSettingsColumns = actualSchema.get('app_settings');
  if (appSettingsColumns?.has('key') && appSettingsColumns.has('value')) {
    const versionResult = await query(
      `SELECT value FROM public.app_settings WHERE key = 'schema_version' LIMIT 1`
    );
    const parsedVersion = Number.parseInt(versionResult.rows[0]?.value, 10);
    actualSchemaVersion = Number.isInteger(parsedVersion) ? parsedVersion : null;
  }
  const schemaVersionMatches = actualSchemaVersion === REQUIRED_SCHEMA_VERSION;

  const report = {
    ok: missingTables.length === 0 && missingColumns.length === 0 && schemaVersionMatches,
    summary: {
      requiredTables: tableNames.length,
      requiredColumns: requiredColumnCount,
      missingTables: missingTables.length,
      missingColumns: missingColumns.length,
      schemaVersionMismatch: !schemaVersionMatches
    },
    schemaVersion: {
      required: REQUIRED_SCHEMA_VERSION,
      actual: actualSchemaVersion,
      matches: schemaVersionMatches
    },
    missing: {
      tables: missingTables.sort(),
      columns: missingColumns.sort()
    }
  };

  if (report.ok) {
    console.log(
      `[Schema Check] OK: version ${REQUIRED_SCHEMA_VERSION}, ` +
      `${tableNames.length} tables, ${requiredColumnCount} required columns`
    );
    return report;
  }

  console.error('[Schema Check] Missing:');
  for (const table of report.missing.tables) console.error(`- ${table}`);
  for (const column of report.missing.columns) console.error(`- ${column}`);
  if (!schemaVersionMatches) {
    console.error(`- schema_version: required ${REQUIRED_SCHEMA_VERSION}, actual ${actualSchemaVersion ?? 'missing'}`);
  }

  if (throwOnMissing) {
    const incompatibilities = [];
    if (missingTables.length > 0 || missingColumns.length > 0) {
      incompatibilities.push(
        `${missingTables.length} tables and ${missingColumns.length} required columns are missing`
      );
    }
    if (!schemaVersionMatches) {
      incompatibilities.push(
        `schema version ${actualSchemaVersion ?? 'missing'} does not match required version ${REQUIRED_SCHEMA_VERSION}`
      );
    }
    const error = new Error(`Database schema is incompatible: ${incompatibilities.join('; ')}.`);
    error.code = 'SCHEMA_CONTRACT_MISMATCH';
    error.schemaReport = report;
    throw error;
  }

  return report;
}



