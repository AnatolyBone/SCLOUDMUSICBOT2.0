import { toFiniteNumber } from './revenueNumber.js';

const MOSCOW_TIME_ZONE = 'Europe/Moscow';
const RETENTION_DAYS = Object.freeze([1, 7, 30, 90]);
const CANONICAL_SOURCES = Object.freeze([
  'organic', 'unknown', 'referrals', 'broadcasts', 'advertising',
  'vpn_bot', 'yandex', 'telegram_channel', 'other'
]);

const EVENT_PRESENTATION = Object.freeze({
  registration: ['Регистрация', 'person-plus', 'primary'],
  session_started: ['Начал сессию', 'play-circle', 'secondary'],
  track_search_started: ['Поиск трека', 'search', 'info'],
  track_download_requested: ['Запросил скачивание', 'download', 'info'],
  track_download_success: ['Скачал трек', 'check-circle', 'success'],
  track_download_failed: ['Ошибка скачивания', 'x-circle', 'danger'],
  download: ['Скачал трек', 'check-circle', 'success'],
  daily_limit_reached: ['Достиг дневного лимита', 'speedometer', 'warning'],
  download_attempt_over_limit: ['Попытка сверх лимита', 'exclamation-triangle', 'warning'],
  playlist_limit_reached: ['Достигнут лимит плейлиста', 'music-note-list', 'warning'],
  star_payment_option_shown: ['Открыл тарифы', 'credit-card', 'info'],
  subscription_plan_clicked: ['Выбрал тариф', 'hand-index', 'primary'],
  star_invoice_created: ['Создан Stars Invoice', 'receipt', 'primary'],
  payment_created: ['Создан платёж', 'cash-stack', 'primary'],
  payment_completed: ['Оплата завершена', 'cash-coin', 'success'],
  subscription_operation: ['Premium изменён', 'gem', 'success'],
  broadcast_received: ['Получил рассылку', 'broadcast', 'secondary'],
  broadcast_clicked: ['Кликнул по рассылке', 'cursor', 'info'],
  language_history: ['Смена языка', 'translate', 'secondary']
});

function parseInteger(value, fallback, min, max, fieldName) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${fieldName} должен быть целым числом.`);
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${fieldName} должен быть в диапазоне ${min}–${max}.`);
  }
  return parsed;
}

async function resolveQuery(queryFn) {
  if (typeof queryFn === 'function') return queryFn;
  const database = await import('../db.js');
  return database.query;
}

export function parseUserId(value) {
  const normalized = String(value ?? '').trim();
  if (!/^\d{1,19}$/.test(normalized) || normalized === '0'
      || BigInt(normalized) > 9_223_372_036_854_775_807n) {
    throw new Error('user_id должен быть положительным целым числом.');
  }
  return normalized;
}

export function parseIsoDate(value, fieldName) {
  const normalized = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error(`${fieldName} должен иметь формат YYYY-MM-DD.`);
  }
  const parsed = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new Error(`${fieldName} содержит некорректную дату.`);
  }
  return normalized;
}

function defaultMoscowDate(daysAgo = 0) {
  return new Date(Date.now() - daysAgo * 86_400_000)
    .toLocaleDateString('en-CA', { timeZone: MOSCOW_TIME_ZONE });
}

function parseDateRange(options, defaultDays = 29) {
  const startDate = parseIsoDate(options.startDate || defaultMoscowDate(defaultDays), 'startDate');
  const endDate = parseIsoDate(options.endDate || defaultMoscowDate(), 'endDate');
  if (startDate > endDate) throw new Error('startDate не может быть позже endDate.');
  const spanDays = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000);
  if (spanDays > 366) throw new Error('Диапазон дат не может превышать 367 дней.');
  return {
    startDate,
    endDate,
    startAt: `${startDate}T00:00:00+03:00`,
    endAt: `${endDate}T23:59:59.999+03:00`
  };
}

function parseCanonicalSource(value) {
  if (value === undefined || value === null || value === '') return null;
  const source = String(value).trim().toLowerCase();
  if (!CANONICAL_SOURCES.includes(source)) {
    throw new Error('source содержит неподдерживаемую каноническую группу.');
  }
  return source;
}

export function classifyAcquisitionSource({ referrerId, referrer_id, referralSource, referral_source } = {}) {
  const referrer = referrerId ?? referrer_id;
  if (referrer !== null && referrer !== undefined && String(referrer) !== '') return 'referrals';
  const source = String(referralSource ?? referral_source ?? '').trim().toLowerCase();
  if (!source || source === 'unknown') return 'unknown';
  if (['organic', 'direct', 'start'].includes(source)) return 'organic';
  if (/(broadcast|campaign|mailing|рассыл)/.test(source)) return 'broadcasts';
  if (/(yandex|яндекс)/.test(source)) return 'yandex';
  if (/(vpn|proxy)/.test(source)) return 'vpn_bot';
  if (/(telegram|tg_|channel|канал)/.test(source)) return 'telegram_channel';
  if (/(ad_|ads|advert|promo|utm_|google|tiktok|vk)/.test(source)) return 'advertising';
  return 'other';
}

const SOURCE_CATEGORY_SQL = `
  CASE
    WHEN u.referrer_id IS NOT NULL THEN 'referrals'
    WHEN NULLIF(BTRIM(u.referral_source), '') IS NULL
      OR LOWER(BTRIM(u.referral_source)) = 'unknown' THEN 'unknown'
    WHEN LOWER(BTRIM(u.referral_source)) IN ('organic', 'direct', 'start') THEN 'organic'
    WHEN LOWER(u.referral_source) ~ '(broadcast|campaign|mailing|рассыл)' THEN 'broadcasts'
    WHEN LOWER(u.referral_source) ~ '(yandex|яндекс)' THEN 'yandex'
    WHEN LOWER(u.referral_source) ~ '(vpn|proxy)' THEN 'vpn_bot'
    WHEN LOWER(u.referral_source) ~ '(telegram|tg_|channel|канал)' THEN 'telegram_channel'
    WHEN LOWER(u.referral_source) ~ '(ad_|ads|advert|promo|utm_|google|tiktok|vk)' THEN 'advertising'
    ELSE 'other'
  END
`;

function humanizeEventName(name) {
  return String(name || 'event').replace(/_/g, ' ').replace(/^./, value => value.toUpperCase());
}

export function presentTimelineEvent(row) {
  const [label, icon, tone] = EVENT_PRESENTATION[row.event_name] || [humanizeEventName(row.event_name), 'circle', 'secondary'];
  return {
    id: row.event_key,
    name: row.event_name,
    label,
    icon,
    tone,
    category: row.event_category || 'other',
    source: row.source_table,
    occurredAt: row.occurred_at,
    details: row.details && typeof row.details === 'object' ? row.details : {}
  };
}

export const TIMELINE_SQL = `
  WITH raw_events AS (
    SELECT 'user:' || u.id::text AS event_key, 'registration'::text AS event_name,
           'lifecycle'::text AS event_category, u.created_at AS occurred_at,
           'users'::text AS source_table,
           jsonb_strip_nulls(jsonb_build_object('username', u.username, 'first_name', u.first_name,
             'referrer_id', u.referrer_id, 'referral_source', u.referral_source)) AS details
      FROM public.users u WHERE u.id = $1
    UNION ALL
    SELECT 'analytics:' || e.id::text, e.event_name, COALESCE(e.event_category, 'analytics'),
           e.created_at, 'analytics_events',
           jsonb_strip_nulls(jsonb_build_object('plan', e.event_data->>'plan',
             'amount_minor', e.event_data->>'amount_minor', 'currency', e.event_data->>'currency',
             'limit', e.event_data->>'limit', 'downloads_today', e.event_data->>'downloads_today',
             'track_title', COALESCE(e.event_data->>'track_title', e.event_data->>'title'),
             'error_code', e.event_data->>'error_code',
             'failure_reason', e.event_data->>'failure_reason',
             'download_source', e.event_data->>'source',
             'download_stage', e.event_data->>'stage',
             'pricing_open_reason', e.event_data->>'pricing_open_reason',
             'playlist_limit', e.event_data->>'playlist_limit',
             'requested_tracks', e.event_data->>'requested_tracks',
             'event_origin', e.event_origin,
             'acquisition_source', e.acquisition_source, 'placement', e.placement,
             'campaign_id', e.campaign_id, 'language_code', e.language_code))
      FROM public.analytics_events e
     WHERE e.user_id = $1
       AND NOT (e.event_name = 'track_download_success' AND (
         NULLIF(e.event_data->>'download_log_id', '') IS NOT NULL OR EXISTS (
           SELECT 1 FROM public.downloads_log d
            WHERE d.user_id = e.user_id
              AND d.downloaded_at BETWEEN e.created_at - INTERVAL '5 minutes'
                                      AND e.created_at + INTERVAL '5 minutes')))
    UNION ALL
    SELECT 'payment:' || p.id::text || ':created', 'payment_created', 'payments', p.created_at,
           'payments', jsonb_strip_nulls(jsonb_build_object('payment_id', p.id, 'plan', p.plan,
             'amount_minor', p.amount_minor, 'currency', p.currency,
             'payment_method', p.payment_method, 'payment_status', p.payment_status))
      FROM public.payments p WHERE p.user_id = $1
    UNION ALL
    SELECT 'payment:' || p.id::text || ':completed', 'payment_completed', 'payments', p.paid_at,
           'payments', jsonb_strip_nulls(jsonb_build_object('payment_id', p.id, 'plan', p.plan,
             'amount_minor', p.amount_minor, 'currency', p.currency,
             'payment_method', p.payment_method, 'payment_status', p.payment_status))
      FROM public.payments p
     WHERE p.user_id = $1 AND p.payment_status = 'completed' AND p.paid_at IS NOT NULL
    UNION ALL
    SELECT 'broadcast-log:' || bl.id::text, 'broadcast_received', 'broadcasts', bl.sent_at,
           'broadcast_log', jsonb_strip_nulls(jsonb_build_object('broadcast_id', bl.broadcast_id,
             'status', bl.status, 'delivered_language', bl.delivered_language))
      FROM public.broadcast_log bl
     WHERE bl.user_id = $1 AND bl.sent_at IS NOT NULL AND bl.status = 'sent'
    UNION ALL
    SELECT 'broadcast-click:' || bc.id::text, 'broadcast_clicked', 'broadcasts', bc.clicked_at,
           'broadcast_clicks', jsonb_strip_nulls(jsonb_build_object('campaign_id', bc.campaign_id,
             'button_index', bc.button_index, 'language_code', bc.language_code))
      FROM public.broadcast_clicks bc WHERE bc.user_id = $1
    UNION ALL
    SELECT 'download:' || dl.id::text, 'download', 'downloads', dl.downloaded_at,
           'downloads_log', jsonb_strip_nulls(jsonb_build_object('download_id', dl.id,
             'track_title', dl.track_title, 'source', dl.source))
      FROM public.downloads_log dl WHERE dl.user_id = $1
    UNION ALL
    SELECT 'language:' || lh.id::text, 'language_history', 'language', lh.created_at,
           'language_history', jsonb_strip_nulls(jsonb_build_object('previous_language', lh.previous_language,
             'new_language', lh.new_language, 'previous_source', lh.previous_source,
             'new_source', lh.new_source, 'changed_by_type', lh.changed_by_type))
      FROM public.language_history lh WHERE lh.user_id = $1
    UNION ALL
    SELECT 'action:' || ual.id::text, COALESCE(NULLIF(ual.action_type, ''), 'user_action'),
           'actions', ual.created_at, 'user_actions_log',
           jsonb_build_object('details_recorded', ual.details IS NOT NULL)
      FROM public.user_actions_log ual WHERE ual.user_id = $1
  ), recent AS (
    SELECT * FROM raw_events
     WHERE occurred_at IS NOT NULL
       AND ($2::timestamptz IS NULL OR occurred_at >= $2::timestamptz)
       AND ($3::timestamptz IS NULL OR occurred_at <= $3::timestamptz)
       AND ($4::timestamptz IS NULL OR occurred_at < $4::timestamptz
         OR (occurred_at = $4::timestamptz AND event_key < $5::text))
     ORDER BY occurred_at DESC, event_key DESC
     LIMIT $6
  )
  SELECT * FROM recent ORDER BY occurred_at DESC, event_key DESC
`;

export async function getUserTimeline(userIdValue, options = {}, queryFn = null) {
  queryFn = await resolveQuery(queryFn);
  const userId = parseUserId(userIdValue);
  const limit = parseInteger(options.limit, 50, 1, 200, 'limit');
  const startAt = options.startDate ? `${parseIsoDate(options.startDate, 'startDate')}T00:00:00+03:00` : null;
  const endAt = options.endDate ? `${parseIsoDate(options.endDate, 'endDate')}T23:59:59.999+03:00` : null;
  if (startAt && endAt && startAt > endAt) throw new Error('startDate не может быть позже endDate.');
  const beforeOccurredAt = options.beforeOccurredAt ? String(options.beforeOccurredAt).trim() : null;
  const beforeEventId = options.beforeEventId ? String(options.beforeEventId).trim() : null;
  if (Boolean(beforeOccurredAt) !== Boolean(beforeEventId)) {
    throw new Error('beforeOccurredAt и beforeEventId должны передаваться вместе.');
  }
  if (beforeOccurredAt && (!/^\d{4}-\d{2}-\d{2}T/.test(beforeOccurredAt)
      || Number.isNaN(new Date(beforeOccurredAt).getTime()))) {
    throw new Error('beforeOccurredAt содержит некорректную дату.');
  }
  if (beforeEventId && !/^[a-z0-9:_-]{1,120}$/i.test(beforeEventId)) {
    throw new Error('beforeEventId содержит недопустимые символы.');
  }
  const [userResult, eventResult] = await Promise.all([
    queryFn(`SELECT id, username, first_name, created_at, last_active, total_downloads,
                    premium_limit, premium_until, referrer_id, referral_source,
                    language_code, active
               FROM public.users WHERE id = $1`, [userId]),
    queryFn(TIMELINE_SQL, [userId, startAt, endAt, beforeOccurredAt, beforeEventId, limit + 1])
  ]);
  const user = userResult.rows[0];
  if (!user) return null;
  const hasMore = eventResult.rows.length > limit;
  const pageRows = eventResult.rows.slice(0, limit);
  const events = pageRows.map(presentTimelineEvent);
  return {
    user: { ...user, id: String(user.id), acquisitionCategory: classifyAcquisitionSource(user) },
    events,
    summary: { eventCount: events.length },
    pagination: {
      limit,
      hasMore,
      nextCursor: hasMore && pageRows.length ? {
        beforeOccurredAt: pageRows.at(-1).occurred_at,
        beforeEventId: pageRows.at(-1).event_key
      } : null
    }
  };
}

const RETENTION_ACTIVITY_CTE = `
  activity_days AS MATERIALIZED (
    SELECT c.user_id, aud.day FROM cohort c
      JOIN public.analytics_user_daily aud ON aud.user_id = c.user_id
       AND aud.day > c.registration_date AND aud.day <= c.registration_date + 90
    UNION
    SELECT c.user_id, timezone('Europe/Moscow', ae.created_at)::date FROM cohort c
      JOIN public.analytics_events ae ON ae.user_id = c.user_id
       AND ae.created_at >= (c.registration_date + 1)::timestamp AT TIME ZONE 'Europe/Moscow'
       AND ae.created_at < (c.registration_date + 91)::timestamp AT TIME ZONE 'Europe/Moscow'
     WHERE ae.event_origin = 'live'
    UNION
    SELECT c.user_id, timezone('Europe/Moscow', dl.downloaded_at)::date FROM cohort c
      JOIN public.downloads_log dl ON dl.user_id = c.user_id
       AND dl.downloaded_at >= (c.registration_date + 1)::timestamp AT TIME ZONE 'Europe/Moscow'
       AND dl.downloaded_at < (c.registration_date + 91)::timestamp AT TIME ZONE 'Europe/Moscow'
  )
`;

export const RETENTION_SUMMARY_SQL = `
  WITH cohort AS (
    SELECT u.id AS user_id, timezone('Europe/Moscow', u.created_at)::date AS registration_date
      FROM public.users u
     WHERE u.created_at BETWEEN $1::timestamptz AND $2::timestamptz
       AND ($3::text IS NULL OR ${SOURCE_CATEGORY_SQL} = $3::text)
  ), ${RETENTION_ACTIVITY_CTE}
  SELECT COUNT(*)::int AS cohort_size,
    COUNT(*) FILTER (WHERE timezone('Europe/Moscow', now())::date >= registration_date + 1)::int AS eligible_d1,
    COUNT(*) FILTER (WHERE timezone('Europe/Moscow', now())::date >= registration_date + 7)::int AS eligible_d7,
    COUNT(*) FILTER (WHERE timezone('Europe/Moscow', now())::date >= registration_date + 30)::int AS eligible_d30,
    COUNT(*) FILTER (WHERE timezone('Europe/Moscow', now())::date >= registration_date + 90)::int AS eligible_d90,
    COUNT(*) FILTER (WHERE timezone('Europe/Moscow', now())::date >= registration_date + 1 AND EXISTS (SELECT 1 FROM activity_days a WHERE a.user_id = c.user_id AND a.day = registration_date + 1))::int AS returned_d1,
    COUNT(*) FILTER (WHERE timezone('Europe/Moscow', now())::date >= registration_date + 7 AND EXISTS (SELECT 1 FROM activity_days a WHERE a.user_id = c.user_id AND a.day = registration_date + 7))::int AS returned_d7,
    COUNT(*) FILTER (WHERE timezone('Europe/Moscow', now())::date >= registration_date + 30 AND EXISTS (SELECT 1 FROM activity_days a WHERE a.user_id = c.user_id AND a.day = registration_date + 30))::int AS returned_d30,
    COUNT(*) FILTER (WHERE timezone('Europe/Moscow', now())::date >= registration_date + 90 AND EXISTS (SELECT 1 FROM activity_days a WHERE a.user_id = c.user_id AND a.day = registration_date + 90))::int AS returned_d90
    FROM cohort c
`;

export const RETENTION_USERS_SQL = `
  WITH cohort AS (
    SELECT u.id AS user_id, u.username, u.created_at, u.last_active, u.total_downloads,
           u.referrer_id, u.referral_source,
           timezone('Europe/Moscow', u.created_at)::date AS registration_date
      FROM public.users u
     WHERE u.created_at BETWEEN $1::timestamptz AND $2::timestamptz
       AND ($3::text IS NULL OR ${SOURCE_CATEGORY_SQL} = $3::text)
  ), ${RETENTION_ACTIVITY_CTE}, eligible AS (
    SELECT c.*, EXISTS (SELECT 1 FROM activity_days a WHERE a.user_id = c.user_id
      AND a.day = c.registration_date + $4::int) AS returned
      FROM cohort c
     WHERE timezone('Europe/Moscow', now())::date >= c.registration_date + $4::int
  ), filtered AS (
    SELECT * FROM eligible e WHERE $5::text = 'all'
      OR ($5::text = 'returned' AND e.returned)
      OR ($5::text = 'not_returned' AND NOT e.returned)
  )
  SELECT f.*, COUNT(*) OVER()::int AS filtered_count,
    EXISTS (SELECT 1 FROM public.analytics_events ae WHERE ae.user_id = f.user_id
      AND ae.event_name IN ('daily_limit_reached', 'download_attempt_over_limit')) AS reached_limit,
    EXISTS (SELECT 1 FROM public.analytics_events ae WHERE ae.user_id = f.user_id
      AND ae.event_name = 'star_payment_option_shown') AS opened_tariffs,
    EXISTS (SELECT 1 FROM public.broadcast_log bl WHERE bl.user_id = f.user_id
      AND bl.status = 'sent') AS received_broadcast,
    EXISTS (SELECT 1 FROM public.payments p WHERE p.user_id = f.user_id
      AND p.payment_status = 'completed') AS paid
    FROM filtered f ORDER BY f.created_at DESC, f.user_id DESC LIMIT $6 OFFSET $7
`;

function retentionSummary(row) {
  const result = { cohortSize: toFiniteNumber(row.cohort_size) };
  for (const day of RETENTION_DAYS) {
    const eligible = toFiniteNumber(row[`eligible_d${day}`]);
    const returned = toFiniteNumber(row[`returned_d${day}`]);
    result[`d${day}`] = {
      eligible,
      returned,
      notReturned: Math.max(eligible - returned, 0),
      rate: eligible > 0 ? returned / eligible * 100 : null
    };
  }
  return result;
}

export async function getRetentionExplorer(options = {}, queryFn = null) {
  queryFn = await resolveQuery(queryFn);
  const { startDate, endDate, startAt, endAt } = parseDateRange(options);
  const source = parseCanonicalSource(options.source);
  const view = options.view || 'summary';
  if (!['summary', 'users'].includes(view)) throw new Error('view содержит неподдерживаемое значение.');
  if (view === 'summary') {
    const result = await queryFn(RETENTION_SUMMARY_SQL, [startAt, endAt, source]);
    return { period: { startDate, endDate }, source, summary: retentionSummary(result.rows[0] || {}) };
  }
  const day = parseInteger(options.day, 7, 1, 90, 'day');
  if (!RETENTION_DAYS.includes(day)) throw new Error('Поддерживаются D1, D7, D30 и D90.');
  const segment = options.segment || 'not_returned';
  if (!['all', 'returned', 'not_returned'].includes(segment)) throw new Error('segment содержит неподдерживаемое значение.');
  const page = parseInteger(options.page, 1, 1, 100_000, 'page');
  const limit = parseInteger(options.limit, 50, 1, 100, 'limit');
  const result = await queryFn(RETENTION_USERS_SQL, [startAt, endAt, source, day, segment, limit, (page - 1) * limit]);
  const total = toFiniteNumber(result.rows[0]?.filtered_count);
  return {
    period: { startDate, endDate }, source, selected: { day, segment },
    users: result.rows.map(row => ({
      id: String(row.user_id), username: row.username, createdAt: row.created_at,
      lastActive: row.last_active, downloads: toFiniteNumber(row.total_downloads),
      returned: Boolean(row.returned), reachedLimit: Boolean(row.reached_limit),
      openedTariffs: Boolean(row.opened_tariffs), receivedBroadcast: Boolean(row.received_broadcast),
      paid: Boolean(row.paid), acquisitionCategory: classifyAcquisitionSource(row),
      referralSource: row.referral_source
    })),
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }
  };
}

export const ACQUISITION_SOURCES_SQL = `
  WITH settings AS (
    SELECT COALESCE((SELECT value::numeric FROM public.app_settings WHERE key = 'xtr_rub_rate'), 2.00)::float8 AS xtr_rate
  ), cohort AS (
    SELECT u.id AS user_id, timezone('Europe/Moscow', u.created_at)::date AS registration_date,
           ${SOURCE_CATEGORY_SQL} AS source_category
      FROM public.users u WHERE u.created_at BETWEEN $1::timestamptz AND $2::timestamptz
  ), payment_totals AS (
    SELECT p.user_id, SUM(CASE WHEN p.currency = 'RUB' THEN p.amount_minor::numeric / 100.0
      WHEN p.currency = 'XTR' THEN p.amount_minor::numeric * s.xtr_rate ELSE 0 END)::float8 AS revenue_rub_equivalent
      FROM cohort c JOIN public.payments p ON p.user_id = c.user_id CROSS JOIN settings s
     WHERE p.payment_status = 'completed' GROUP BY p.user_id
  ), activity_days AS (
    SELECT c.user_id, aud.day FROM cohort c JOIN public.analytics_user_daily aud
      ON aud.user_id = c.user_id AND aud.day = c.registration_date + 7
    UNION
    SELECT c.user_id, timezone('Europe/Moscow', ae.created_at)::date FROM cohort c
      JOIN public.analytics_events ae ON ae.user_id = c.user_id
       AND ae.created_at >= (c.registration_date + 7)::timestamp AT TIME ZONE 'Europe/Moscow'
       AND ae.created_at < (c.registration_date + 8)::timestamp AT TIME ZONE 'Europe/Moscow'
     WHERE ae.event_origin = 'live'
    UNION
    SELECT c.user_id, timezone('Europe/Moscow', dl.downloaded_at)::date FROM cohort c
      JOIN public.downloads_log dl ON dl.user_id = c.user_id
       AND dl.downloaded_at >= (c.registration_date + 7)::timestamp AT TIME ZONE 'Europe/Moscow'
       AND dl.downloaded_at < (c.registration_date + 8)::timestamp AT TIME ZONE 'Europe/Moscow'
  ), d7_activity AS (SELECT DISTINCT c.user_id FROM cohort c JOIN activity_days a
      ON a.user_id = c.user_id AND a.day = c.registration_date + 7)
  SELECT c.source_category AS source, COUNT(*)::int AS registrations,
         COUNT(pt.user_id)::int AS paying_users,
         COALESCE(SUM(pt.revenue_rub_equivalent), 0)::float8 AS revenue_rub_equivalent,
         COUNT(*) FILTER (WHERE timezone('Europe/Moscow', now())::date >= c.registration_date + 7)::int AS d7_eligible,
         COUNT(d7.user_id)::int AS d7_returned
    FROM cohort c LEFT JOIN payment_totals pt ON pt.user_id = c.user_id
    LEFT JOIN d7_activity d7 ON d7.user_id = c.user_id
   GROUP BY c.source_category ORDER BY registrations DESC, source ASC
`;

export const RAW_SOURCES_SQL = `
  SELECT CASE WHEN u.referrer_id IS NOT NULL THEN 'referral'
           ELSE COALESCE(NULLIF(BTRIM(u.referral_source), ''), 'unknown') END AS raw_source,
         ${SOURCE_CATEGORY_SQL} AS normalized_source, COUNT(*)::int AS registrations
    FROM public.users u WHERE u.created_at BETWEEN $1::timestamptz AND $2::timestamptz
   GROUP BY 1, 2 ORDER BY registrations DESC, raw_source ASC LIMIT 100
`;

export async function getAcquisitionSourceExplorer(options = {}, queryFn = null) {
  queryFn = await resolveQuery(queryFn);
  const { startDate, endDate, startAt, endAt } = parseDateRange(options);
  const [sourceResult, rawResult] = await Promise.all([
    queryFn(ACQUISITION_SOURCES_SQL, [startAt, endAt]),
    queryFn(RAW_SOURCES_SQL, [startAt, endAt])
  ]);
  return {
    period: { startDate, endDate },
    sources: sourceResult.rows.map(row => {
      const registrations = toFiniteNumber(row.registrations);
      const payingUsers = toFiniteNumber(row.paying_users);
      const revenue = toFiniteNumber(row.revenue_rub_equivalent);
      const d7Eligible = toFiniteNumber(row.d7_eligible);
      const d7Returned = toFiniteNumber(row.d7_returned);
      return {
        source: row.source, registrations, payingUsers,
        conversion: registrations ? payingUsers / registrations * 100 : 0,
        revenueRubEquivalent: revenue,
        ltv: registrations ? revenue / registrations : 0,
        arppu: payingUsers ? revenue / payingUsers : 0,
        retentionD7: d7Eligible ? d7Returned / d7Eligible * 100 : null,
        d7Eligible, d7Returned
      };
    }),
    rawSources: rawResult.rows.map(row => ({
      rawSource: row.raw_source,
      normalizedSource: row.normalized_source,
      registrations: toFiniteNumber(row.registrations)
    }))
  };
}
