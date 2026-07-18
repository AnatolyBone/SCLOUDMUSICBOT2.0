import { query } from '../db.js';
import { getSetting } from './settingsManager.js';
import { getProductIntelligenceAnalytics } from './productIntelligenceService.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_WINDOWS = new Map([
  ['1h', 3600],
  ['24h', 86400],
  ['7d', 604800],
  ['30d', 2592000]
]);
const MAX_DRILLDOWN_LIMIT = 200;
const DEFAULT_COMPLETE_FROM = '2026-07-17';

export const PAYMENT_FUNNEL_EVENTS = Object.freeze({
  menu: ['star_payment_option_shown'],
  plan: ['subscription_plan_clicked'],
  invoice: ['star_invoice_created'],
  pre_checkout: ['star_pre_checkout_received'],
  alternative: [
    'alternative_payment_methods_opened',
    'other_payment_methods_opened',
    'tbank_payment_link_opened',
    'boosty_payment_link_opened',
    'yoomoney_plus_link_opened',
    'yoomoney_pro_link_opened',
    'yoomoney_unlimited_link_opened'
  ]
});

export const PAYMENT_EVENT_CONTRACT = Object.freeze([
  'star_payment_option_shown',
  'subscription_plan_clicked',
  'star_invoice_created',
  'star_pre_checkout_received',
  'payment_completed',
  'subscription_activated',
  'subscription_renewed',
  'other_payment_methods_opened',
  'yoomoney_plus_link_opened',
  'yoomoney_pro_link_opened',
  'yoomoney_unlimited_link_opened',
  'tbank_payment_link_opened',
  'boosty_payment_link_opened',
  'daily_limit_reached',
  'download_attempt_over_limit',
  'playlist_limit_reached',
  'track_download_requested',
  'track_download_success',
  'track_download_failed'
]);

function asInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseIdList(value) {
  return String(value || '')
    .split(/[\s,;]+/)
    .map(item => item.trim())
    .filter(item => /^-?\d+$/.test(item))
    .filter((item, index, all) => all.indexOf(item) === index);
}

export function getAnalyticsExcludedUserIds() {
  return parseIdList([
    process.env.ADMIN_ID,
    process.env.ANALYTICS_EXCLUDED_USER_IDS,
    getSetting('analytics_excluded_user_ids')
  ].filter(Boolean).join(','));
}

export function validatePaymentLossFilters(input = {}) {
  const now = new Date();
  const endDate = DAY_RE.test(String(input.endDate || ''))
    ? String(input.endDate)
    : now.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
  const defaultStart = new Date(now.getTime() - 30 * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
  const startDate = DAY_RE.test(String(input.startDate || '')) ? String(input.startDate) : defaultStart;
  if (startDate > endDate) throw new Error('startDate must not be after endDate');
  const maxSpanDays = 366;
  if ((new Date(`${endDate}T00:00:00Z`) - new Date(`${startDate}T00:00:00Z`)) / 86400000 > maxSpanDays) {
    throw new Error(`Date range must not exceed ${maxSpanDays} days`);
  }
  const window = ALLOWED_WINDOWS.has(String(input.window)) ? String(input.window) : '24h';
  return {
    startDate,
    endDate,
    window,
    windowSeconds: ALLOWED_WINDOWS.get(window),
    startAt: `${startDate}T00:00:00+03:00`,
    endAt: `${endDate}T23:59:59.999+03:00`
  };
}

const JOURNEY_CTES = `
  WITH menu_events AS (
    SELECT ae.id, ae.user_id, ae.created_at AS menu_at,
           ae.event_source, ae.placement, ae.acquisition_source
    FROM public.analytics_events ae
    WHERE ae.event_name = 'star_payment_option_shown'
      AND ae.created_at BETWEEN $1::timestamptz AND $2::timestamptz
      AND NOT (ae.user_id = ANY($4::bigint[]))
  ),
  menu_candidates AS (
    SELECT m.*,
           pay.id AS payment_id, pay.paid_at, pay.plan AS payment_plan,
           pay.payment_method, pay.currency, pay.amount_minor,
           ROW_NUMBER() OVER (
             PARTITION BY m.user_id
             ORDER BY (pay.id IS NOT NULL) DESC,
                      CASE WHEN pay.id IS NULL THEN NULL ELSE pay.paid_at - m.menu_at END ASC NULLS LAST,
                      m.menu_at ASC, m.id ASC
           ) AS anchor_rank
    FROM menu_events m
    LEFT JOIN LATERAL (
      SELECT p.id, p.paid_at, p.plan, p.payment_method, p.currency, p.amount_minor
      FROM public.payments p
      WHERE p.user_id = m.user_id
        AND p.payment_status = 'completed'
        AND p.paid_at >= m.menu_at
        AND p.paid_at <= m.menu_at + make_interval(secs => $3::int)
      ORDER BY p.paid_at ASC, p.id ASC
      LIMIT 1
    ) pay ON TRUE
  ),
  anchors AS (
    SELECT * FROM menu_candidates WHERE anchor_rank = 1
  ),
  journeys AS (
    SELECT a.*,
           selected.event_id AS plan_event_id,
           selected.event_at AS plan_at,
           selected.plan AS selected_plan,
           selected.event_source AS plan_event_source,
           invoice.event_id AS invoice_event_id,
           invoice.event_at AS invoice_at,
           checkout.event_id AS checkout_event_id,
           checkout.event_at AS checkout_at,
           COALESCE(a.payment_plan, selected.plan) AS attributed_plan
    FROM anchors a
    LEFT JOIN LATERAL (
      SELECT ae.id AS event_id, ae.created_at AS event_at,
             NULLIF(LOWER(ae.event_data->>'plan'), '') AS plan,
             ae.event_source
      FROM public.analytics_events ae
      WHERE ae.user_id = a.user_id
        AND ae.event_name = 'subscription_plan_clicked'
        AND ae.created_at >= a.menu_at
        AND ae.created_at <= a.menu_at + make_interval(secs => $3::int)
      ORDER BY ae.created_at ASC, ae.id ASC LIMIT 1
    ) selected ON TRUE
    LEFT JOIN LATERAL (
      SELECT ae.id AS event_id, ae.created_at AS event_at
      FROM public.analytics_events ae
      WHERE ae.user_id = a.user_id
        AND ae.event_name = 'star_invoice_created'
        AND ae.created_at >= COALESCE(selected.event_at, a.menu_at)
        AND ae.created_at <= a.menu_at + make_interval(secs => $3::int)
      ORDER BY ae.created_at ASC, ae.id ASC LIMIT 1
    ) invoice ON TRUE
    LEFT JOIN LATERAL (
      SELECT ae.id AS event_id, ae.created_at AS event_at
      FROM public.analytics_events ae
      WHERE ae.user_id = a.user_id
        AND ae.event_name = 'star_pre_checkout_received'
        AND ae.created_at >= COALESCE(invoice.event_at, selected.event_at, a.menu_at)
        AND ae.created_at <= a.menu_at + make_interval(secs => $3::int)
      ORDER BY ae.created_at ASC, ae.id ASC LIMIT 1
    ) checkout ON TRUE
  )`;

const FUNNEL_SQL = `${JOURNEY_CTES},
  counts AS (
    SELECT
      COUNT(*)::int AS menu_users,
      COUNT(*) FILTER (WHERE plan_event_id IS NOT NULL)::int AS plan_users,
      COUNT(*) FILTER (WHERE invoice_event_id IS NOT NULL)::int AS invoice_users,
      COUNT(*) FILTER (WHERE checkout_event_id IS NOT NULL)::int AS checkout_users,
      COUNT(*) FILTER (WHERE payment_id IS NOT NULL)::int AS payment_users,
      COUNT(*) FILTER (WHERE plan_event_id IS NULL)::int AS menu_drop,
      COUNT(*) FILTER (WHERE plan_event_id IS NOT NULL AND invoice_event_id IS NULL)::int AS plan_drop,
      COUNT(*) FILTER (WHERE invoice_event_id IS NOT NULL AND checkout_event_id IS NULL)::int AS invoice_drop,
      COUNT(*) FILTER (WHERE checkout_event_id IS NOT NULL AND payment_id IS NULL)::int AS checkout_drop
    FROM journeys
  ), event_counts AS (
    SELECT
      COUNT(*) FILTER (WHERE event_name = 'star_payment_option_shown')::int AS menu_events,
      COUNT(*) FILTER (WHERE event_name = 'subscription_plan_clicked')::int AS plan_events,
      COUNT(*) FILTER (WHERE event_name = 'star_invoice_created')::int AS invoice_events,
      COUNT(*) FILTER (WHERE event_name = 'star_pre_checkout_received')::int AS checkout_events
    FROM public.analytics_events
    WHERE created_at BETWEEN $1::timestamptz AND $2::timestamptz
      AND event_name = ANY(ARRAY['star_payment_option_shown','subscription_plan_clicked','star_invoice_created','star_pre_checkout_received'])
      AND NOT (user_id = ANY($4::bigint[]))
  )
  SELECT c.*, e.*,
         (SELECT COUNT(payment_id)::int FROM journeys) AS payment_events
  FROM counts c CROSS JOIN event_counts e`;

const PLAN_SQL = `${JOURNEY_CTES}
  SELECT COALESCE(attributed_plan, 'unknown') AS plan,
         COUNT(*) FILTER (WHERE plan_event_id IS NOT NULL)::int AS selected_users,
         COUNT(*) FILTER (WHERE invoice_event_id IS NOT NULL)::int AS invoice_users,
         COUNT(*) FILTER (WHERE checkout_event_id IS NOT NULL)::int AS checkout_users,
         COUNT(*) FILTER (WHERE payment_id IS NOT NULL)::int AS payment_users,
         AVG(EXTRACT(EPOCH FROM (paid_at - menu_at))) FILTER (WHERE payment_id IS NOT NULL)::float AS avg_seconds_to_payment,
         AVG((SELECT COUNT(*) FROM public.downloads_log dl
              WHERE dl.user_id = journeys.user_id
                AND dl.downloaded_at BETWEEN menu_at - interval '7 days' AND menu_at))::float AS avg_downloads_before,
         COUNT(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM public.analytics_events lim
           WHERE lim.user_id = journeys.user_id AND lim.event_name = 'daily_limit_reached'
             AND lim.created_at BETWEEN menu_at - interval '24 hours' AND menu_at
         ))::int AS reached_limit_users
  FROM journeys
  WHERE attributed_plan IN ('plus','pro','unlim')
  GROUP BY attributed_plan
  ORDER BY CASE attributed_plan WHEN 'plus' THEN 1 WHEN 'pro' THEN 2 ELSE 3 END`;

const ALTERNATIVE_SQL = `
  WITH alt AS (
    SELECT DISTINCT ON (ae.user_id) ae.user_id, ae.created_at AS opened_at,
           ae.event_name, NULLIF(LOWER(ae.event_data->>'plan'), '') AS plan
    FROM public.analytics_events ae
    WHERE ae.event_name = ANY($5::text[])
      AND ae.created_at BETWEEN $1::timestamptz AND $2::timestamptz
      AND $3::int > 0
      AND NOT (ae.user_id = ANY($4::bigint[]))
    ORDER BY ae.user_id, ae.created_at ASC, ae.id ASC
  )
  SELECT COUNT(*)::int AS opened_users,
         COUNT(*) FILTER (WHERE p24.id IS NOT NULL)::int AS paid_24h_users,
         COUNT(*) FILTER (WHERE p7.id IS NOT NULL)::int AS paid_7d_users
  FROM alt
  LEFT JOIN LATERAL (
    SELECT p.id FROM public.payments p
    WHERE p.user_id = alt.user_id AND p.payment_status = 'completed'
      AND p.currency = 'RUB' AND p.paid_at BETWEEN alt.opened_at AND alt.opened_at + interval '24 hours'
    ORDER BY p.paid_at, p.id LIMIT 1
  ) p24 ON TRUE
  LEFT JOIN LATERAL (
    SELECT p.id FROM public.payments p
    WHERE p.user_id = alt.user_id AND p.payment_status = 'completed'
      AND p.currency = 'RUB' AND p.paid_at BETWEEN alt.opened_at AND alt.opened_at + interval '7 days'
    ORDER BY p.paid_at, p.id LIMIT 1
  ) p7 ON TRUE`;

const BEHAVIOR_SQL = `${JOURNEY_CTES}
  SELECT
    COUNT(*) FILTER (WHERE payment_id IS NULL)::int AS unpaid_users,
    COUNT(*) FILTER (WHERE payment_id IS NULL AND EXISTS (
      SELECT 1 FROM public.downloads_log dl WHERE dl.user_id = journeys.user_id
      AND dl.downloaded_at BETWEEN menu_at AND menu_at + make_interval(secs => $3::int)))::int AS downloaded_again,
    COUNT(*) FILTER (WHERE payment_id IS NULL AND EXISTS (
      SELECT 1 FROM public.analytics_events ae WHERE ae.user_id = journeys.user_id
      AND ae.event_name = 'daily_limit_reached' AND ae.created_at BETWEEN menu_at AND menu_at + make_interval(secs => $3::int)))::int AS reached_limit_again,
    COUNT(*) FILTER (WHERE payment_id IS NULL AND EXISTS (
      SELECT 1 FROM public.analytics_events ae WHERE ae.user_id = journeys.user_id
      AND ae.event_name = 'star_payment_option_shown' AND ae.created_at > menu_at
      AND ae.created_at <= menu_at + make_interval(secs => $3::int)))::int AS reopened_tariffs,
    COUNT(*) FILTER (WHERE payment_id IS NULL AND EXISTS (
      SELECT 1 FROM public.analytics_events ae WHERE ae.user_id = journeys.user_id
      AND ae.event_name = 'subscription_plan_clicked' AND ae.created_at > COALESCE(plan_at, menu_at)
      AND ae.created_at <= menu_at + make_interval(secs => $3::int)
      AND NULLIF(LOWER(ae.event_data->>'plan'), '') IS DISTINCT FROM selected_plan))::int AS changed_plan,
    COUNT(*) FILTER (WHERE payment_id IS NULL AND EXISTS (
      SELECT 1 FROM public.analytics_events ae WHERE ae.user_id = journeys.user_id
      AND ae.event_name = ANY($5::text[]) AND ae.created_at BETWEEN menu_at AND menu_at + make_interval(secs => $3::int)))::int AS opened_alternative,
    COUNT(*) FILTER (WHERE payment_id IS NULL AND EXISTS (
      SELECT 1 FROM public.analytics_events ae WHERE ae.user_id = journeys.user_id
      AND ae.created_at >= menu_at + interval '1 day' AND ae.created_at < menu_at + interval '2 days'))::int AS returned_d1,
    COUNT(*) FILTER (WHERE payment_id IS NULL AND EXISTS (
      SELECT 1 FROM public.analytics_events ae WHERE ae.user_id = journeys.user_id
      AND ae.created_at >= menu_at + interval '7 days' AND ae.created_at < menu_at + interval '8 days'))::int AS returned_d7,
    COUNT(*) FILTER (WHERE payment_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM public.analytics_events ae WHERE ae.user_id = journeys.user_id
      AND ae.created_at > menu_at AND ae.created_at <= menu_at + make_interval(secs => $3::int)))::int AS no_observed_activity,
    COUNT(*) FILTER (WHERE payment_id IS NULL AND EXISTS (
      SELECT 1 FROM public.unprocessed_payments_log upl WHERE upl.user_id = journeys.user_id
      AND upl.created_at BETWEEN menu_at AND menu_at + make_interval(secs => $3::int)))::int AS payment_error_users
  FROM journeys`;

const SEGMENTS_SQL = `${JOURNEY_CTES}
  SELECT segment, COUNT(*)::int AS users,
         COUNT(*) FILTER (WHERE payment_id IS NOT NULL)::int AS payers
  FROM journeys j
  JOIN public.users u ON u.id = j.user_id
  CROSS JOIN LATERAL (VALUES
    ('Новые пользователи', u.created_at >= j.menu_at - interval '7 days'),
    ('Старые пользователи', u.created_at < j.menu_at - interval '7 days'),
    ('Вернулись после 7+ дней', EXISTS (
      SELECT 1 FROM public.analytics_events returned
      WHERE returned.user_id = j.user_id
        AND returned.event_name = 'user_returned_after_inactivity'
        AND returned.created_at BETWEEN j.menu_at - interval '7 days' AND j.menu_at
    )),
    ('Достигли лимита', EXISTS (
      SELECT 1 FROM public.analytics_events limited
      WHERE limited.user_id = j.user_id
        AND limited.event_name IN ('daily_limit_reached','download_attempt_over_limit')
        AND limited.created_at BETWEEN j.menu_at - interval '24 hours' AND j.menu_at
    )),
    ('Не достигли лимита', NOT EXISTS (
      SELECT 1 FROM public.analytics_events limited
      WHERE limited.user_id = j.user_id
        AND limited.event_name IN ('daily_limit_reached','download_attempt_over_limit')
        AND limited.created_at BETWEEN j.menu_at - interval '24 hours' AND j.menu_at
    )),
    ('Пришли по рефералу', u.referrer_id IS NOT NULL),
    ('Органические', u.referrer_id IS NULL AND LOWER(COALESCE(NULLIF(BTRIM(u.referral_source), ''), 'organic')) IN ('organic','direct','start')),
    ('RU', LOWER(COALESCE(u.language_code, 'ru')) = 'ru'),
    ('EN', LOWER(COALESCE(u.language_code, 'ru')) = 'en')
  ) AS segment_rule(segment, matches)
  WHERE segment_rule.matches
  GROUP BY segment
  ORDER BY users DESC, segment`;

const CONTENT_SOURCE_SQL = `${JOURNEY_CTES}
  SELECT content_source, entry_source,
         COUNT(*)::int AS users,
         COALESCE(SUM(successful_downloads), 0)::int AS successful_downloads,
         COALESCE(SUM(download_errors), 0)::int AS errors,
         COUNT(*) FILTER (WHERE reached_limit)::int AS limit_users,
         COUNT(*) FILTER (WHERE plan_event_id IS NOT NULL)::int AS selected_users,
         COUNT(*) FILTER (WHERE invoice_event_id IS NOT NULL)::int AS invoice_users,
         COUNT(*) FILTER (WHERE checkout_event_id IS NOT NULL)::int AS checkout_users,
         COUNT(*) FILTER (WHERE payment_id IS NOT NULL)::int AS payers,
         COUNT(*) FILTER (WHERE returned_d1)::int AS returned_d1,
         COUNT(*) FILTER (WHERE returned_d7)::int AS returned_d7
  FROM (
    SELECT j.*,
      CASE
        WHEN LOWER(COALESCE(download.delivery_source, '')) = 'cache' THEN 'Кэш'
        WHEN LOWER(COALESCE(download.source, '')) LIKE '%spotify%' THEN 'Spotify'
        WHEN LOWER(COALESCE(download.source, '')) LIKE '%soundcloud%' THEN 'SoundCloud'
        WHEN LOWER(COALESCE(download.source, '')) LIKE '%youtube%' THEN 'YouTube'
        WHEN LOWER(COALESCE(download.source, '')) IN ('cache', 'cached') THEN 'Кэш'
        WHEN download.source IS NULL OR BTRIM(download.source) = '' THEN 'Не определён'
        ELSE 'Другой источник'
      END AS content_source,
      CASE
        WHEN request.event_source = 'inline_query' THEN 'Inline'
        WHEN request.event_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.analytics_events search
          WHERE search.user_id = j.user_id AND search.event_name = 'track_search_started'
            AND search.created_at BETWEEN request.requested_at - interval '30 minutes' AND request.requested_at
        ) THEN 'Search'
        WHEN request.event_id IS NOT NULL THEN 'Direct URL'
        ELSE 'Не определён'
      END AS entry_source,
      (SELECT COUNT(*)::int FROM public.downloads_log dl_count
       WHERE dl_count.user_id = j.user_id
         AND dl_count.downloaded_at BETWEEN j.menu_at - interval '7 days' AND j.menu_at) AS successful_downloads,
      (SELECT COUNT(*)::int FROM public.analytics_events err
       WHERE err.user_id = j.user_id
         AND err.event_name IN ('track_download_failed','track_download_error','download_error')
         AND err.created_at BETWEEN j.menu_at - interval '7 days' AND j.menu_at) AS download_errors,
      EXISTS (SELECT 1 FROM public.analytics_events limited
       WHERE limited.user_id = j.user_id
         AND limited.event_name IN ('daily_limit_reached','download_attempt_over_limit')
         AND limited.created_at BETWEEN j.menu_at - interval '24 hours' AND j.menu_at) AS reached_limit,
      EXISTS (SELECT 1 FROM public.analytics_events activity
       WHERE activity.user_id = j.user_id
         AND activity.created_at >= j.menu_at + interval '1 day'
         AND activity.created_at < j.menu_at + interval '2 days') AS returned_d1,
      EXISTS (SELECT 1 FROM public.analytics_events activity
       WHERE activity.user_id = j.user_id
         AND activity.created_at >= j.menu_at + interval '7 days'
         AND activity.created_at < j.menu_at + interval '8 days') AS returned_d7
    FROM journeys j
    LEFT JOIN LATERAL (
      SELECT dl.source,
             (
               SELECT ae.event_data->>'delivery_source'
               FROM public.analytics_events ae
               WHERE ae.user_id = dl.user_id
                 AND ae.event_name = 'track_download_success'
                 AND ae.event_data->>'download_log_id' = dl.id::text
               ORDER BY ae.created_at DESC, ae.id DESC
               LIMIT 1
             ) AS delivery_source
      FROM public.downloads_log dl
      WHERE dl.user_id = j.user_id
        AND dl.downloaded_at BETWEEN j.menu_at - interval '7 days' AND j.menu_at
      ORDER BY dl.downloaded_at DESC, dl.id DESC
      LIMIT 1
    ) download ON TRUE
    LEFT JOIN LATERAL (
      SELECT ae.id AS event_id, ae.created_at AS requested_at, ae.event_source
      FROM public.analytics_events ae
      WHERE ae.user_id = j.user_id
        AND ae.event_name = 'track_download_requested'
        AND ae.created_at BETWEEN j.menu_at - interval '7 days' AND j.menu_at
      ORDER BY ae.created_at DESC, ae.id DESC
      LIMIT 1
    ) request ON TRUE
  ) sourced
  GROUP BY content_source, entry_source
  ORDER BY users DESC, content_source, entry_source`;

const PAYMENT_ERRORS_SQL = `${JOURNEY_CTES}
  SELECT error_category, COUNT(DISTINCT user_id)::int AS users,
         COUNT(*)::int AS events
  FROM (
    SELECT j.user_id, upl.id,
      CASE
        WHEN LOWER(COALESCE(upl.error_message, '')) ~ 'auth|password|credential|token' THEN 'Авторизация'
        WHEN LOWER(COALESCE(upl.error_message, '')) ~ 'amount|currency|price|total' THEN 'Сумма или валюта'
        WHEN LOWER(COALESCE(upl.error_message, '')) ~ 'rpc|status|order|already.processed' THEN 'Статус заказа / RPC'
        WHEN LOWER(COALESCE(upl.error_message, '')) ~ 'telegram|provider|charge' THEN 'Провайдер оплаты'
        ELSE 'Прочая техническая ошибка'
      END AS error_category
    FROM journeys j
    JOIN public.unprocessed_payments_log upl
      ON upl.user_id = j.user_id
     AND upl.created_at BETWEEN j.menu_at AND j.menu_at + make_interval(secs => $3::int)
    WHERE j.payment_id IS NULL
  ) errors
  GROUP BY error_category
  ORDER BY users DESC, error_category`;

const ALTERNATIVE_DETAIL_SQL = `
  WITH alt_events AS (
    SELECT ae.id, ae.user_id, ae.created_at AS opened_at,
      CASE
        WHEN ae.event_name LIKE 'yoomoney_%' THEN 'YooMoney'
        WHEN ae.event_name = 'tbank_payment_link_opened' THEN 'Т-Банк / СБП'
        WHEN ae.event_name = 'boosty_payment_link_opened' THEN 'Boosty'
        ELSE 'Другие способы / администратор'
      END AS method
    FROM public.analytics_events ae
    WHERE ae.event_name = ANY($5::text[])
      AND ae.created_at BETWEEN $1::timestamptz AND $2::timestamptz
      AND $3::int > 0
      AND NOT (ae.user_id = ANY($4::bigint[]))
  ), first_choice AS (
    SELECT DISTINCT ON (user_id, method) *
    FROM alt_events ORDER BY user_id, method, opened_at, id
  ), choices_with_payment AS (
    SELECT choice.*, payment.id AS payment_id, payment.paid_at,
           ROW_NUMBER() OVER (
             PARTITION BY payment.id
             ORDER BY payment.paid_at - choice.opened_at, choice.opened_at DESC, choice.id DESC
           ) AS payment_rank
    FROM first_choice choice
    LEFT JOIN LATERAL (
      SELECT p.id, p.paid_at
      FROM public.payments p
      WHERE p.user_id = choice.user_id
        AND p.payment_status = 'completed'
        AND p.currency = 'RUB'
        AND p.paid_at BETWEEN choice.opened_at AND choice.opened_at + interval '7 days'
      ORDER BY p.paid_at, p.id LIMIT 1
    ) payment ON TRUE
  ), event_counts AS (
    SELECT method, COUNT(*)::int AS request_events
    FROM alt_events GROUP BY method
  )
  SELECT c.method,
         COUNT(*)::int AS opened_users,
         MAX(e.request_events)::int AS request_events,
         COUNT(*) FILTER (WHERE c.payment_id IS NOT NULL AND c.payment_rank = 1
                           AND c.paid_at <= c.opened_at + interval '24 hours')::int AS paid_24h_users,
         COUNT(*) FILTER (WHERE c.payment_id IS NOT NULL AND c.payment_rank = 1)::int AS paid_7d_users,
         AVG(EXTRACT(EPOCH FROM (c.paid_at - c.opened_at)))
           FILTER (WHERE c.payment_id IS NOT NULL AND c.payment_rank = 1)::float AS avg_seconds_to_payment
  FROM choices_with_payment c
  JOIN event_counts e USING (method)
  GROUP BY c.method
  ORDER BY opened_users DESC, c.method`;

const DERIVED_METRICS_SQL = `${JOURNEY_CTES},
  limit_events AS (
    SELECT DISTINCT ON (ae.user_id) ae.user_id, ae.created_at AS limit_at
    FROM public.analytics_events ae
    WHERE ae.event_name IN ('daily_limit_reached','download_attempt_over_limit')
      AND ae.created_at BETWEEN $1::timestamptz AND $2::timestamptz
      AND NOT (ae.user_id = ANY($4::bigint[]))
    ORDER BY ae.user_id, ae.created_at, ae.id
  )
  SELECT
    COUNT(*) FILTER (WHERE j.payment_id IS NOT NULL)::int AS paid_users,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (j.paid_at - j.menu_at)))
      FILTER (WHERE j.payment_id IS NOT NULL)::float AS median_seconds_to_payment,
    AVG((SELECT COUNT(*) FROM public.downloads_log dl
         WHERE dl.user_id = j.user_id
           AND dl.downloaded_at BETWEEN j.menu_at - interval '30 days' AND j.menu_at))
      FILTER (WHERE j.payment_id IS NOT NULL)::float AS avg_downloads_before_purchase,
    AVG(EXTRACT(EPOCH FROM (j.paid_at - u.created_at)) / 86400.0)
      FILTER (WHERE j.payment_id IS NOT NULL)::float AS avg_days_registration_to_payment,
    (SELECT COUNT(*)::int FROM limit_events) AS limit_users,
    (SELECT COUNT(*)::int FROM limit_events l WHERE EXISTS (
      SELECT 1 FROM journeys after_limit WHERE after_limit.user_id = l.user_id
        AND after_limit.menu_at BETWEEN l.limit_at AND l.limit_at + make_interval(secs => $3::int)
    )) AS limit_to_menu_users,
    (SELECT COUNT(*)::int FROM limit_events l WHERE EXISTS (
      SELECT 1 FROM public.payments p WHERE p.user_id = l.user_id
        AND p.payment_status = 'completed'
        AND p.paid_at BETWEEN l.limit_at AND l.limit_at + make_interval(secs => $3::int)
    )) AS limit_to_payment_users
  FROM journeys j
  JOIN public.users u ON u.id = j.user_id`;

const DOWNLOAD_CONTEXT_SQL = `${JOURNEY_CTES}
  SELECT
    COUNT(*) FILTER (WHERE successful_before)::int AS menu_after_success,
    COUNT(*) FILTER (WHERE error_before)::int AS menu_after_error,
    COUNT(*) FILTER (WHERE successful_before AND payment_id IS NOT NULL)::int AS paid_after_success,
    COUNT(*) FILTER (WHERE error_before AND payment_id IS NOT NULL)::int AS paid_after_error,
    COUNT(*) FILTER (WHERE successful_before AND error_before)::int AS both_success_and_error,
    COALESCE(SUM(error_attempts), 0)::int AS error_events,
    COALESCE(SUM(success_attempts), 0)::int AS successful_downloads
  FROM (
    SELECT j.*,
      EXISTS (SELECT 1 FROM public.downloads_log dl WHERE dl.user_id = j.user_id
        AND dl.downloaded_at BETWEEN j.menu_at - interval '7 days' AND j.menu_at) AS successful_before,
      EXISTS (SELECT 1 FROM public.analytics_events err WHERE err.user_id = j.user_id
        AND err.event_name IN ('track_download_failed','track_download_error','download_error')
        AND err.created_at BETWEEN j.menu_at - interval '7 days' AND j.menu_at) AS error_before,
      (SELECT COUNT(*)::int FROM public.analytics_events err WHERE err.user_id = j.user_id
        AND err.event_name IN ('track_download_failed','track_download_error','download_error')
        AND err.created_at BETWEEN j.menu_at - interval '7 days' AND j.menu_at) AS error_attempts,
      (SELECT COUNT(*)::int FROM public.downloads_log dl WHERE dl.user_id = j.user_id
        AND dl.downloaded_at BETWEEN j.menu_at - interval '7 days' AND j.menu_at) AS success_attempts
    FROM journeys j
  ) context`;

const EVENT_CONTRACT_SQL = `
  WITH required(event_name) AS (SELECT UNNEST($5::text[])),
  observed AS (
    SELECT ae.event_name, COUNT(*)::int AS events,
           COUNT(DISTINCT ae.user_id)::int AS users,
           BOOL_OR(ae.event_data ? 'plan') AS has_plan,
           BOOL_OR(ae.placement IS NOT NULL OR ae.event_data ? 'placement') AS has_placement,
           BOOL_OR(ae.event_data ? 'order_id') AS has_order_id,
           BOOL_OR(ae.event_data ? 'payment_method') AS has_payment_method,
           BOOL_OR(ae.event_data ? 'source') AS has_source,
           BOOL_OR(ae.event_data ? 'pricing_open_reason') AS has_pricing_open_reason,
           BOOL_OR(ae.deduplication_key IS NOT NULL OR ae.event_data ? 'deduplication_key') AS has_deduplication_key
    FROM public.analytics_events ae
    WHERE ae.event_name = ANY($5::text[])
      AND ae.created_at BETWEEN $1::timestamptz AND $2::timestamptz
      AND $3::int > 0
      AND NOT (ae.user_id = ANY($4::bigint[]))
    GROUP BY ae.event_name
  )
  SELECT required.event_name, COALESCE(observed.events, 0)::int AS events,
         COALESCE(observed.users, 0)::int AS users,
         COALESCE(observed.has_plan, false) AS has_plan,
         COALESCE(observed.has_placement, false) AS has_placement,
         COALESCE(observed.has_order_id, false) AS has_order_id,
         COALESCE(observed.has_payment_method, false) AS has_payment_method,
         COALESCE(observed.has_source, false) AS has_source,
         COALESCE(observed.has_pricing_open_reason, false) AS has_pricing_open_reason,
         COALESCE(observed.has_deduplication_key, false) AS has_deduplication_key
  FROM required LEFT JOIN observed USING (event_name)
  ORDER BY required.event_name`;

function pct(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator * 100).toFixed(2)) : null;
}

function createFunnel(row) {
  const stages = [
    ['menu', 'Открыли меню тарифов', asInteger(row.menu_users), asInteger(row.menu_events)],
    ['plan', 'Выбрали тариф', asInteger(row.plan_users), asInteger(row.plan_events)],
    ['invoice', 'Получили Stars invoice', asInteger(row.invoice_users), asInteger(row.invoice_events)],
    ['pre_checkout', 'Прошли pre-checkout', asInteger(row.checkout_users), asInteger(row.checkout_events)],
    ['payment', 'Успешно оплатили', asInteger(row.payment_users), asInteger(row.payment_events)]
  ];
  return stages.map((stage, index) => {
    const previous = index ? stages[index - 1][2] : stage[2];
    const first = stages[0][2];
    return {
      key: stage[0], label: stage[1], users: stage[2], events: stage[3],
      conversionFromPrevious: pct(stage[2], previous),
      conversionFromFirst: pct(stage[2], first),
      dropoutUsers: index ? Math.max(0, previous - stage[2]) : 0,
      dropoutPercent: index ? pct(Math.max(0, previous - stage[2]), previous) : 0
    };
  });
}

export async function getPaymentLossAnalytics(input = {}, { queryFn = query } = {}) {
  const filters = validatePaymentLossFilters(input);
  const excludedUserIds = getAnalyticsExcludedUserIds();
  const params = [filters.startAt, filters.endAt, filters.windowSeconds, excludedUserIds];
  const altEvents = PAYMENT_FUNNEL_EVENTS.alternative;
  const [
    funnelRes,
    plansRes,
    altRes,
    behaviorRes,
    segmentsRes,
    contentSourcesRes,
    paymentErrorsRes,
    alternativeDetailsRes,
    derivedRes,
    downloadContextRes,
    eventContractRes,
    productIntelligence
  ] = await Promise.all([
    queryFn(FUNNEL_SQL, params),
    queryFn(PLAN_SQL, params),
    queryFn(ALTERNATIVE_SQL, [...params, altEvents]),
    queryFn(BEHAVIOR_SQL, [...params, altEvents]),
    queryFn(SEGMENTS_SQL, params),
    queryFn(CONTENT_SOURCE_SQL, params),
    queryFn(PAYMENT_ERRORS_SQL, params),
    queryFn(ALTERNATIVE_DETAIL_SQL, [...params, altEvents]),
    queryFn(DERIVED_METRICS_SQL, params),
    queryFn(DOWNLOAD_CONTEXT_SQL, params),
    queryFn(EVENT_CONTRACT_SQL, [...params, PAYMENT_EVENT_CONTRACT]),
    getProductIntelligenceAnalytics(filters, excludedUserIds, queryFn)
  ]);
  const completeFrom = getSetting('analytics_payment_funnel_complete_from') || DEFAULT_COMPLETE_FROM;
  const productIntelligenceCompleteFrom = getSetting('analytics_product_intelligence_complete_from') || DEFAULT_COMPLETE_FROM;
  const isCompleteRange = filters.startDate >= completeFrom;
  const funnel = createFunnel(funnelRes.rows[0] || {});
  if (!isCompleteRange) {
    for (const stage of funnel) {
      stage.conversionFromPrevious = null;
      stage.conversionFromFirst = null;
      stage.dropoutUsers = null;
      stage.dropoutPercent = null;
    }
  }
  const plans = plansRes.rows.map(row => ({
    plan: row.plan === 'unlim' ? 'Unlimited' : String(row.plan || '').replace(/^./, c => c.toUpperCase()),
    selectedUsers: asInteger(row.selected_users), invoiceUsers: asInteger(row.invoice_users),
    preCheckoutUsers: asInteger(row.checkout_users), paymentUsers: asInteger(row.payment_users),
    conversion: isCompleteRange ? pct(asInteger(row.payment_users), asInteger(row.selected_users)) : null,
    avgSecondsToPayment: row.avg_seconds_to_payment == null ? null : asNumber(row.avg_seconds_to_payment),
    avgDownloadsBefore: row.avg_downloads_before == null ? null : asNumber(row.avg_downloads_before),
    reachedLimitUsers: asInteger(row.reached_limit_users)
  }));
  const alternative = altRes.rows[0] || {};
  const behavior = behaviorRes.rows[0] || {};
  const segmentRows = segmentsRes.rows || [];
  const derived = derivedRes.rows[0] || {};
  const downloadContext = downloadContextRes.rows[0] || {};
  const hasDownloadErrorTelemetry = asInteger(downloadContext.error_events) > 0;
  const sample = funnel[0]?.users || 0;
  const weakest = funnel.slice(1).reduce((best, stage) => !best || (stage.dropoutPercent || 0) > (best.dropoutPercent || 0) ? stage : best, null);
  const recommendations = !isCompleteRange || sample < 30 ? [] : [{
    type: 'warning',
    title: `Наибольшая подтверждённая потеря: ${weakest?.label || 'нет данных'}`,
    text: `${weakest?.dropoutUsers || 0} пользователей (${weakest?.dropoutPercent ?? 0}%) не дошли от предыдущего подтверждённого шага. Причина не утверждается без отдельного события ошибки.`
  }];
  const baseCounts = funnelRes.rows[0] || {};
  const derivedMetrics = {
    menuToPlanCtr: isCompleteRange ? pct(asInteger(baseCounts.plan_users), asInteger(baseCounts.menu_users)) : null,
    planToInvoiceConversion: isCompleteRange ? pct(asInteger(baseCounts.invoice_users), asInteger(baseCounts.plan_users)) : null,
    invoiceToPreCheckoutConversion: isCompleteRange ? pct(asInteger(baseCounts.checkout_users), asInteger(baseCounts.invoice_users)) : null,
    preCheckoutToPaymentConversion: isCompleteRange ? pct(asInteger(baseCounts.payment_users), asInteger(baseCounts.checkout_users)) : null,
    menuToPaymentConversion: isCompleteRange ? pct(asInteger(baseCounts.payment_users), asInteger(baseCounts.menu_users)) : null,
    limitToMenuConversion: isCompleteRange ? pct(asInteger(derived.limit_to_menu_users), asInteger(derived.limit_users)) : null,
    limitToPaymentConversion: isCompleteRange ? pct(asInteger(derived.limit_to_payment_users), asInteger(derived.limit_users)) : null,
    alternativePaymentConversion24h: isCompleteRange ? pct(asInteger(alternative.paid_24h_users), asInteger(alternative.opened_users)) : null,
    medianSecondsToPayment: derived.median_seconds_to_payment == null ? null : asNumber(derived.median_seconds_to_payment),
    avgDownloadsBeforePurchase: derived.avg_downloads_before_purchase == null ? null : asNumber(derived.avg_downloads_before_purchase),
    avgDaysRegistrationToPayment: derived.avg_days_registration_to_payment == null ? null : asNumber(derived.avg_days_registration_to_payment)
  };
  return {
    ok: true,
    filters: { startDate: filters.startDate, endDate: filters.endDate, window: filters.window },
    dataCompleteness: {
      completeFrom,
      isCompleteRange,
      note: isCompleteRange
        ? 'Все обязательные события воронки считаются доступными для выбранного периода.'
        : `До ${completeFrom} отдельные этапы могли не логироваться; значения следует трактовать как минимум.`
    },
    exclusions: { count: excludedUserIds.length },
    funnel,
    plans,
    alternative: {
      openedUsers: asInteger(alternative.opened_users),
      paid24hUsers: asInteger(alternative.paid_24h_users),
      paid7dUsers: asInteger(alternative.paid_7d_users),
      conversion24h: isCompleteRange ? pct(asInteger(alternative.paid_24h_users), asInteger(alternative.opened_users)) : null,
      conversion7d: isCompleteRange ? pct(asInteger(alternative.paid_7d_users), asInteger(alternative.opened_users)) : null,
      methods: (alternativeDetailsRes.rows || []).map(row => ({
        method: row.method,
        openedUsers: asInteger(row.opened_users),
        requestEvents: asInteger(row.request_events),
        paid24hUsers: asInteger(row.paid_24h_users),
        paid7dUsers: asInteger(row.paid_7d_users),
        conversion24h: isCompleteRange ? pct(asInteger(row.paid_24h_users), asInteger(row.opened_users)) : null,
        conversion7d: isCompleteRange ? pct(asInteger(row.paid_7d_users), asInteger(row.opened_users)) : null,
        avgSecondsToPayment: row.avg_seconds_to_payment == null ? null : asNumber(row.avg_seconds_to_payment)
      }))
    },
    postFunnel: Object.fromEntries(Object.entries(behavior).map(([key, value]) => [key, asInteger(value)])),
    segments: segmentRows.map(row => ({
      segment: row.segment, users: asInteger(row.users), payers: asInteger(row.payers),
      conversion: isCompleteRange ? pct(asInteger(row.payers), asInteger(row.users)) : null
    })),
    contentSources: (contentSourcesRes.rows || []).map(row => ({
      source: row.content_source,
      entrySource: row.entry_source,
      users: asInteger(row.users),
      successfulDownloads: asInteger(row.successful_downloads),
      errors: hasDownloadErrorTelemetry ? asInteger(row.errors) : null,
      avgDownloads: asInteger(row.users) > 0
        ? Number((asInteger(row.successful_downloads) / asInteger(row.users)).toFixed(2))
        : null,
      reachedLimitUsers: asInteger(row.limit_users),
      selectedUsers: asInteger(row.selected_users),
      invoiceUsers: asInteger(row.invoice_users),
      preCheckoutUsers: asInteger(row.checkout_users),
      payers: asInteger(row.payers),
      conversion: isCompleteRange ? pct(asInteger(row.payers), asInteger(row.users)) : null,
      returnedD1: asInteger(row.returned_d1),
      returnedD7: asInteger(row.returned_d7)
    })),
    paymentErrors: (paymentErrorsRes.rows || []).map(row => ({
      category: row.error_category,
      users: asInteger(row.users),
      events: asInteger(row.events)
    })),
    derivedMetrics,
    downloadContext: {
      menuAfterSuccess: asInteger(downloadContext.menu_after_success),
      menuAfterError: asInteger(downloadContext.menu_after_error),
      paidAfterSuccess: asInteger(downloadContext.paid_after_success),
      paidAfterError: asInteger(downloadContext.paid_after_error),
      bothSuccessAndError: asInteger(downloadContext.both_success_and_error),
      errorEvents: asInteger(downloadContext.error_events),
      successfulDownloads: asInteger(downloadContext.successful_downloads),
      errorTelemetryAvailable: hasDownloadErrorTelemetry,
      unavailableFields: ['file_size']
    },
    eventContract: (eventContractRes.rows || []).map(row => ({
      eventName: row.event_name,
      events: asInteger(row.events),
      users: asInteger(row.users),
      fields: {
        plan: Boolean(row.has_plan),
        placement: Boolean(row.has_placement),
        orderId: Boolean(row.has_order_id),
        paymentMethod: Boolean(row.has_payment_method),
        source: Boolean(row.has_source),
        pricingOpenReason: Boolean(row.has_pricing_open_reason),
        deduplicationKey: Boolean(row.has_deduplication_key)
      }
    })),
    productIntelligence: {
      ...productIntelligence,
      telemetry: {
        completeFrom: productIntelligenceCompleteFrom,
        note: `pricing_open_reason и классифицированные ошибки скачивания полноценно собираются с ${productIntelligenceCompleteFrom}.`
      }
    },
    recommendations,
    interpretation: [
      'Этапы показывают уникальных пользователей; events — фактическое число событий.',
      'Платёж атрибутируется к ближайшему предшествующему открытию тарифов в выбранном окне и учитывается один раз.',
      '«Нет активности» означает отсутствие наблюдаемых событий, а не доказанный выход из Telegram.',
      'Ручная RUB-оплата относится к альтернативной ветке только после фактического completed-платежа.',
      'Этап оплаты считается по авторитетной таблице payments; отсутствие payment_completed в analytics_events не обнуляет оплаты.'
    ]
  };
}

const DRILLDOWN_STAGE_SQL = `${JOURNEY_CTES}
  SELECT j.user_id::text, u.username, u.first_name, u.created_at AS registered_at,
         u.language_code, u.referral_source, u.last_active,
         COALESCE(downloads.total, 0)::int AS downloads_total,
         COALESCE(u.downloads_today, 0)::int AS downloads_today,
         EXISTS (SELECT 1 FROM public.analytics_events limited
           WHERE limited.user_id = j.user_id
             AND limited.event_name IN ('daily_limit_reached','download_attempt_over_limit')
             AND limited.created_at BETWEEN j.menu_at - interval '24 hours' AND j.menu_at) AS reached_limit,
         CASE
           WHEN j.payment_id IS NOT NULL THEN 'payment'
           WHEN j.checkout_event_id IS NOT NULL THEN 'pre_checkout'
           WHEN j.invoice_event_id IS NOT NULL THEN 'invoice'
           WHEN j.plan_event_id IS NOT NULL THEN 'plan'
           ELSE 'menu'
         END AS last_tariff_step,
         j.menu_at, j.plan_at, j.invoice_at, j.checkout_at, j.paid_at,
         COALESCE(j.attributed_plan, 'unknown') AS plan,
         COALESCE(errors.count, 0)::int AS payment_errors,
         COUNT(*) OVER()::int AS total
  FROM journeys j
  JOIN public.users u ON u.id=j.user_id
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS total FROM public.downloads_log dl WHERE dl.user_id = j.user_id
  ) downloads ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS count FROM public.unprocessed_payments_log upl
    WHERE upl.user_id = j.user_id
      AND upl.created_at BETWEEN j.menu_at AND j.menu_at + make_interval(secs => $3::int)
  ) errors ON TRUE
  WHERE CASE $5::text
    WHEN 'menu' THEN TRUE
    WHEN 'plan' THEN j.plan_event_id IS NOT NULL
    WHEN 'invoice' THEN j.invoice_event_id IS NOT NULL
    WHEN 'pre_checkout' THEN j.checkout_event_id IS NOT NULL
    WHEN 'payment' THEN j.payment_id IS NOT NULL
    WHEN 'drop_menu' THEN j.plan_event_id IS NULL
    WHEN 'drop_plan' THEN j.plan_event_id IS NOT NULL AND j.invoice_event_id IS NULL
    WHEN 'drop_invoice' THEN j.invoice_event_id IS NOT NULL AND j.checkout_event_id IS NULL
    WHEN 'drop_pre_checkout' THEN j.checkout_event_id IS NOT NULL AND j.payment_id IS NULL
    ELSE FALSE END
  ORDER BY j.menu_at DESC, j.user_id DESC
  LIMIT $6 OFFSET $7`;

const DRILLDOWN_KEYS = new Set(['menu','plan','invoice','pre_checkout','payment','drop_menu','drop_plan','drop_invoice','drop_pre_checkout']);

export async function getPaymentLossUsers(input = {}, { queryFn = query } = {}) {
  const filters = validatePaymentLossFilters(input);
  const stage = DRILLDOWN_KEYS.has(String(input.stage)) ? String(input.stage) : 'menu';
  const page = Math.max(1, asInteger(input.page, 1));
  const limit = Math.min(MAX_DRILLDOWN_LIMIT, Math.max(1, asInteger(input.limit, 50)));
  const excluded = getAnalyticsExcludedUserIds();
  const result = await queryFn(DRILLDOWN_STAGE_SQL, [
    filters.startAt, filters.endAt, filters.windowSeconds, excluded, stage, limit, (page - 1) * limit
  ]);
  const total = asInteger(result.rows[0]?.total);
  return {
    ok: true, stage, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)),
    users: result.rows.map(({ total: _total, ...row }) => row)
  };
}

export const __paymentLossSql = Object.freeze({
  FUNNEL_SQL,
  PLAN_SQL,
  ALTERNATIVE_SQL,
  BEHAVIOR_SQL,
  SEGMENTS_SQL,
  CONTENT_SOURCE_SQL,
  PAYMENT_ERRORS_SQL,
  ALTERNATIVE_DETAIL_SQL,
  DERIVED_METRICS_SQL,
  DOWNLOAD_CONTEXT_SQL,
  EVENT_CONTRACT_SQL,
  DRILLDOWN_STAGE_SQL
});
