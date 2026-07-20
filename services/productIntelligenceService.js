const PRICING_REASONS = new Set([
  'daily_limit', 'manual_command', 'menu_button', 'limit_message',
  'referral_bonus_expired', 'broadcast', 'other'
]);

function integer(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percent(part, total) {
  return total > 0 ? Number((part * 100 / total).toFixed(2)) : null;
}

const BASE_MENU_CTE = `
  WITH menus AS (
    SELECT DISTINCT ON (ae.user_id)
      ae.user_id, ae.id AS menu_id, ae.created_at AS menu_at
    FROM public.analytics_events ae
    WHERE ae.event_name = 'star_payment_option_shown'
      AND ae.created_at BETWEEN $1::timestamptz AND $2::timestamptz
      AND NOT (ae.user_id = ANY($4::bigint[]))
    ORDER BY ae.user_id, ae.created_at, ae.id
  )`;

const PRICING_REASON_SQL = `
  SELECT reason, COUNT(DISTINCT user_id)::int AS users, COUNT(*)::int AS events
  FROM (
    SELECT ae.user_id,
      CASE
        WHEN ae.event_data->>'pricing_open_reason' = ANY($5::text[])
          THEN ae.event_data->>'pricing_open_reason'
        WHEN EXISTS (
          SELECT 1 FROM public.analytics_events lim
          WHERE lim.user_id = ae.user_id
            AND lim.event_name IN ('daily_limit_reached','download_attempt_over_limit')
            AND lim.created_at BETWEEN ae.created_at - interval '30 minutes' AND ae.created_at
        ) THEN 'daily_limit'
        WHEN EXISTS (
          SELECT 1 FROM public.analytics_events lim
          WHERE lim.user_id = ae.user_id
            AND lim.event_name = 'playlist_limit_reached'
            AND lim.created_at BETWEEN ae.created_at - interval '30 minutes' AND ae.created_at
        ) THEN 'daily_limit'
        ELSE 'other'
      END AS reason
    FROM public.analytics_events ae
    WHERE ae.event_name = 'star_payment_option_shown'
      AND ae.created_at BETWEEN $1::timestamptz AND $2::timestamptz
      AND $3::int > 0
      AND NOT (ae.user_id = ANY($4::bigint[]))
  ) reasons
  GROUP BY reason
  ORDER BY users DESC, reason`;

const JOURNEY_TIMINGS_SQL = `${BASE_MENU_CTE}, journeys AS (
    SELECT m.*, u.created_at AS registered_at,
      first_download.downloaded_at AS first_download_at,
      first_limit.limit_at,
      plan.plan_at, invoice.invoice_at, payment.paid_at
    FROM menus m
    JOIN public.users u ON u.id = m.user_id
    LEFT JOIN LATERAL (
      SELECT dl.downloaded_at FROM public.downloads_log dl
      WHERE dl.user_id = m.user_id
      ORDER BY dl.downloaded_at, dl.id LIMIT 1
    ) first_download ON TRUE
    LEFT JOIN LATERAL (
      SELECT ae.created_at AS limit_at FROM public.analytics_events ae
      WHERE ae.user_id = m.user_id
        AND ae.event_name IN ('daily_limit_reached','download_attempt_over_limit','playlist_limit_reached')
        AND ae.created_at <= m.menu_at
      ORDER BY ae.created_at DESC, ae.id DESC LIMIT 1
    ) first_limit ON TRUE
    LEFT JOIN LATERAL (
      SELECT ae.created_at AS plan_at FROM public.analytics_events ae
      WHERE ae.user_id = m.user_id AND ae.event_name = 'subscription_plan_clicked'
        AND ae.created_at BETWEEN m.menu_at AND m.menu_at + make_interval(secs => $3::int)
      ORDER BY ae.created_at, ae.id LIMIT 1
    ) plan ON TRUE
    LEFT JOIN LATERAL (
      SELECT ae.created_at AS invoice_at FROM public.analytics_events ae
      WHERE ae.user_id = m.user_id AND ae.event_name = 'star_invoice_created'
        AND ae.created_at BETWEEN COALESCE(plan.plan_at, m.menu_at) AND m.menu_at + make_interval(secs => $3::int)
      ORDER BY ae.created_at, ae.id LIMIT 1
    ) invoice ON TRUE
    LEFT JOIN LATERAL (
      SELECT p.paid_at FROM public.payments p
      WHERE p.user_id = m.user_id AND p.payment_status = 'completed'
        AND p.paid_at BETWEEN m.menu_at AND m.menu_at + make_interval(secs => $3::int)
      ORDER BY p.paid_at, p.id LIMIT 1
    ) payment ON TRUE
  )
  SELECT COUNT(*)::int AS users,
    COUNT(first_download_at)::int AS first_download_users,
    COUNT(limit_at)::int AS limit_users,
    COUNT(plan_at)::int AS plan_users,
    COUNT(invoice_at)::int AS invoice_users,
    COUNT(paid_at)::int AS payment_users,
    AVG(EXTRACT(EPOCH FROM (first_download_at - registered_at)))
      FILTER (WHERE first_download_at >= registered_at)::float AS registration_to_download_seconds,
    AVG(EXTRACT(EPOCH FROM (limit_at - first_download_at)))
      FILTER (WHERE limit_at >= first_download_at)::float AS download_to_limit_seconds,
    AVG(EXTRACT(EPOCH FROM (menu_at - limit_at)))
      FILTER (WHERE menu_at >= limit_at)::float AS limit_to_menu_seconds,
    AVG(EXTRACT(EPOCH FROM (plan_at - menu_at)))
      FILTER (WHERE plan_at >= menu_at)::float AS menu_to_plan_seconds,
    AVG(EXTRACT(EPOCH FROM (invoice_at - COALESCE(plan_at, menu_at))))
      FILTER (WHERE invoice_at >= COALESCE(plan_at, menu_at))::float AS plan_to_invoice_seconds,
    AVG(EXTRACT(EPOCH FROM (paid_at - invoice_at)))
      FILTER (WHERE paid_at >= invoice_at)::float AS invoice_to_payment_seconds
  FROM journeys`;

const ACTIVITY_CONVERSION_SQL = `${BASE_MENU_CTE}, population AS (
    SELECT m.*,
      (SELECT COUNT(*)::int FROM public.downloads_log dl
       WHERE dl.user_id = m.user_id AND dl.downloaded_at <= m.menu_at) AS downloads,
      EXISTS (
        SELECT 1 FROM public.payments p
        WHERE p.user_id = m.user_id AND p.payment_status = 'completed'
          AND p.paid_at BETWEEN m.menu_at AND m.menu_at + make_interval(secs => $3::int)
      ) AS paid
    FROM menus m
  )
  SELECT CASE
      WHEN downloads <= 5 THEN '0–5'
      WHEN downloads <= 20 THEN '6–20'
      WHEN downloads <= 50 THEN '21–50'
      WHEN downloads <= 100 THEN '51–100'
      ELSE '100+'
    END AS segment,
    COUNT(*)::int AS users,
    COUNT(*) FILTER (WHERE paid)::int AS payers,
    AVG(downloads)::float AS avg_downloads
  FROM population
  GROUP BY 1
  ORDER BY MIN(downloads)`;

const BUYER_COMPARISON_SQL = `${BASE_MENU_CTE}, population AS (
    SELECT m.*, u.created_at AS registered_at,
      (SELECT COUNT(*)::int FROM public.downloads_log dl
       WHERE dl.user_id = m.user_id AND dl.downloaded_at <= m.menu_at) AS downloads,
      EXISTS (SELECT 1 FROM public.analytics_events lim
       WHERE lim.user_id = m.user_id
         AND lim.event_name IN ('daily_limit_reached','download_attempt_over_limit','playlist_limit_reached')
         AND lim.created_at BETWEEN m.menu_at - interval '30 days' AND m.menu_at) AS reached_limit,
      EXISTS (SELECT 1 FROM public.analytics_events ret
       WHERE ret.user_id = m.user_id
         AND ret.created_at BETWEEN m.menu_at + interval '1 day' AND m.menu_at + interval '8 days') AS returned,
      (SELECT COUNT(*)::int FROM public.analytics_events act
       WHERE act.user_id = m.user_id
         AND act.created_at BETWEEN m.menu_at - interval '30 days' AND m.menu_at) AS activity_events,
      EXISTS (SELECT 1 FROM public.payments p
       WHERE p.user_id = m.user_id AND p.payment_status = 'completed'
         AND p.paid_at BETWEEN m.menu_at AND m.menu_at + make_interval(secs => $3::int)) AS paid
    FROM menus m JOIN public.users u ON u.id = m.user_id
  )
  SELECT CASE WHEN paid THEN 'buyers' ELSE 'non_buyers' END AS group_name,
    COUNT(*)::int AS users,
    AVG(EXTRACT(EPOCH FROM (menu_at - registered_at)) / 86400.0)::float AS avg_account_age_days,
    AVG(downloads)::float AS avg_downloads,
    COUNT(*) FILTER (WHERE reached_limit)::int AS reached_limit_users,
    COUNT(*) FILTER (WHERE returned)::int AS returned_users,
    AVG(activity_events)::float AS avg_activity_events
  FROM population GROUP BY paid ORDER BY paid DESC`;

const PAID_RETENTION_SQL = `
  WITH paid_cohort AS (
    SELECT DISTINCT ON (p.user_id) p.user_id, p.paid_at,
      (timezone('Europe/Moscow', p.paid_at))::date AS paid_date
    FROM public.payments p
    WHERE p.payment_status = 'completed'
      AND p.paid_at BETWEEN $1::timestamptz AND $2::timestamptz
      AND $3::int > 0
      AND $3::int > 0
      AND NOT (p.user_id = ANY($4::bigint[]))
    ORDER BY p.user_id, p.paid_at, p.id
  ), activity_days AS (
    SELECT DISTINCT c.user_id, (timezone('Europe/Moscow', ae.created_at))::date AS day
    FROM paid_cohort c JOIN public.analytics_events ae ON ae.user_id = c.user_id
    WHERE ae.created_at > c.paid_at AND ae.created_at < c.paid_at + interval '91 days'
    UNION
    SELECT DISTINCT c.user_id, (timezone('Europe/Moscow', dl.downloaded_at))::date AS day
    FROM paid_cohort c JOIN public.downloads_log dl ON dl.user_id = c.user_id
    WHERE dl.downloaded_at > c.paid_at AND dl.downloaded_at < c.paid_at + interval '91 days'
  ), days(day_number) AS (VALUES (1), (7), (30), (90))
  SELECT d.day_number,
    COUNT(*) FILTER (WHERE (timezone('Europe/Moscow', now()))::date >= c.paid_date + d.day_number)::int AS eligible,
    COUNT(*) FILTER (
      WHERE (timezone('Europe/Moscow', now()))::date >= c.paid_date + d.day_number
        AND EXISTS (SELECT 1 FROM activity_days a
          WHERE a.user_id = c.user_id AND a.day = c.paid_date + d.day_number)
    )::int AS returned
  FROM days d LEFT JOIN paid_cohort c ON TRUE
  GROUP BY d.day_number ORDER BY d.day_number`;

const SOURCE_ECONOMICS_SQL = `
  WITH cohort AS (
    SELECT u.id AS user_id,
      CASE
        WHEN u.referrer_id IS NOT NULL THEN 'referral'
        WHEN LOWER(COALESCE(u.referral_source, '')) ~ 'telega[._ -]?in' THEN 'telega_in'
        WHEN LOWER(COALESCE(u.referral_source, '')) ~ '(telegram[_ -]?ads|tg[_ -]?ads|utm_.*telegram)' THEN 'telegram_ads'
        WHEN LOWER(COALESCE(u.referral_source, '')) ~ '(channel|канал)' THEN 'channel'
        WHEN LOWER(COALESCE(u.referral_source, '')) ~ '(search|поиск|yandex|google)' THEN 'search'
        WHEN LOWER(COALESCE(NULLIF(BTRIM(u.referral_source), ''), '')) IN ('organic','direct','start') THEN 'organic'
        ELSE 'unknown'
      END AS source
    FROM public.users u
    WHERE u.created_at BETWEEN $1::timestamptz AND $2::timestamptz
      AND $3::int > 0
      AND NOT (u.id = ANY($4::bigint[]))
  ), revenue AS (
    SELECT c.user_id, COUNT(p.id)::int AS payments,
      COALESCE(SUM(CASE
        WHEN p.currency = 'RUB' THEN p.amount_minor::numeric / 100.0
        WHEN p.currency = 'XTR' THEN p.amount_minor::numeric * COALESCE(
          (SELECT value::numeric FROM public.app_settings WHERE key = 'xtr_rub_rate'), 2.0)
        ELSE 0 END), 0)::float AS revenue_rub
    FROM cohort c LEFT JOIN public.payments p ON p.user_id = c.user_id
      AND p.payment_status = 'completed' AND p.paid_at <= $2::timestamptz
    GROUP BY c.user_id
  )
  SELECT c.source, COUNT(*)::int AS users,
    COUNT(*) FILTER (WHERE r.payments > 0)::int AS payers,
    COALESCE(SUM(r.revenue_rub), 0)::float AS revenue_rub
  FROM cohort c JOIN revenue r USING (user_id)
  GROUP BY c.source ORDER BY users DESC, c.source`;

const REJECTION_REASONS_SQL = `${BASE_MENU_CTE}, population AS (
    SELECT m.*,
      EXISTS (SELECT 1 FROM public.analytics_events e WHERE e.user_id=m.user_id
        AND e.event_name='subscription_plan_clicked'
        AND e.created_at BETWEEN m.menu_at AND m.menu_at + make_interval(secs => $3::int)) AS has_plan,
      EXISTS (SELECT 1 FROM public.analytics_events e WHERE e.user_id=m.user_id
        AND e.event_name='star_invoice_created'
        AND e.created_at BETWEEN m.menu_at AND m.menu_at + make_interval(secs => $3::int)) AS has_invoice,
      EXISTS (SELECT 1 FROM public.analytics_events e WHERE e.user_id=m.user_id
        AND e.event_name='star_pre_checkout_received'
        AND e.created_at BETWEEN m.menu_at AND m.menu_at + make_interval(secs => $3::int)) AS has_checkout,
      EXISTS (SELECT 1 FROM public.payments p WHERE p.user_id=m.user_id
        AND p.payment_status='completed'
        AND p.paid_at BETWEEN m.menu_at AND m.menu_at + make_interval(secs => $3::int)) AS paid,
      EXISTS (SELECT 1 FROM public.analytics_events e WHERE e.user_id=m.user_id
        AND e.created_at BETWEEN m.menu_at + interval '7 days' AND m.menu_at + interval '8 days') AS returned_d7,
      EXISTS (SELECT 1 FROM public.analytics_events e WHERE e.user_id=m.user_id
        AND e.created_at > m.menu_at AND e.created_at <= m.menu_at + make_interval(secs => $3::int)) AS later_activity
    FROM menus m
  ), reasons AS (
    SELECT CASE
      WHEN paid THEN 'paid'
      WHEN has_checkout THEN 'pre_checkout_without_payment'
      WHEN has_invoice THEN 'invoice_without_pre_checkout'
      WHEN has_plan THEN 'plan_without_invoice'
      ELSE 'menu_without_plan'
    END AS reason, * FROM population
  )
  SELECT reason, COUNT(*)::int AS users FROM reasons
  WHERE reason <> 'paid' GROUP BY reason
  UNION ALL
  SELECT 'returned_after_7d', COUNT(*)::int FROM reasons WHERE reason <> 'paid' AND returned_d7
  UNION ALL
  SELECT 'no_observed_activity', COUNT(*)::int FROM reasons WHERE reason <> 'paid' AND NOT later_activity
  ORDER BY users DESC, reason`;

const DOWNLOAD_FAILURES_SQL = `
  WITH failures AS (
    SELECT ae.user_id, ae.created_at,
      COALESCE(NULLIF(ae.event_data->>'error_category', ''), NULLIF(ae.event_data->>'failure_reason', ''), 'unknown') AS reason,
      COALESCE(NULLIF(LOWER(ae.event_data->>'source'), ''), 'unknown') AS source
    FROM public.analytics_events ae
    WHERE ae.event_name = 'track_download_failed'
      AND ae.created_at BETWEEN $1::timestamptz AND $2::timestamptz
      AND $3::int > 0
      AND NOT (ae.user_id = ANY($4::bigint[]))
  )
  SELECT reason, source, COUNT(*)::int AS events, COUNT(DISTINCT user_id)::int AS users,
    COUNT(DISTINCT user_id) FILTER (WHERE EXISTS (
      SELECT 1 FROM public.analytics_events menu
      WHERE menu.user_id = failures.user_id AND menu.event_name = 'star_payment_option_shown'
        AND menu.created_at BETWEEN failures.created_at AND failures.created_at + interval '7 days'
    ))::int AS opened_menu_users,
    COUNT(DISTINCT user_id) FILTER (WHERE EXISTS (
      SELECT 1 FROM public.analytics_events plan
      WHERE plan.user_id = failures.user_id AND plan.event_name = 'subscription_plan_clicked'
        AND plan.created_at BETWEEN failures.created_at AND failures.created_at + interval '7 days'
    ))::int AS selected_plan_users,
    COUNT(DISTINCT user_id) FILTER (WHERE EXISTS (
      SELECT 1 FROM public.analytics_events invoice
      WHERE invoice.user_id = failures.user_id AND invoice.event_name = 'star_invoice_created'
        AND invoice.created_at BETWEEN failures.created_at AND failures.created_at + interval '7 days'
    ))::int AS invoice_users,
    COUNT(DISTINCT user_id) FILTER (WHERE EXISTS (
      SELECT 1 FROM public.payments p
      WHERE p.user_id = failures.user_id AND p.payment_status = 'completed'
        AND p.paid_at BETWEEN failures.created_at AND failures.created_at + interval '7 days'
    ))::int AS payer_users
  FROM failures GROUP BY reason, source
  ORDER BY users DESC, events DESC, reason, source`;

const LIMIT_REPETITION_SQL = `
  WITH paid AS (
    SELECT p.user_id, MIN(p.paid_at) AS anchor_at, 'paid'::text AS group_name
    FROM public.payments p
    WHERE p.payment_status = 'completed'
      AND p.paid_at BETWEEN $1::timestamptz AND $2::timestamptz
      AND NOT (p.user_id = ANY($4::bigint[]))
    GROUP BY p.user_id
  ), unpaid_opened AS (
    SELECT ae.user_id, MIN(ae.created_at) AS anchor_at, 'opened_not_paid'::text AS group_name
    FROM public.analytics_events ae
    WHERE ae.event_name = 'star_payment_option_shown'
      AND ae.created_at BETWEEN $1::timestamptz AND $2::timestamptz
      AND $3::int > 0
      AND NOT (ae.user_id = ANY($4::bigint[]))
      AND NOT EXISTS (
        SELECT 1 FROM public.payments p
        WHERE p.user_id = ae.user_id AND p.payment_status = 'completed' AND p.paid_at <= $2::timestamptz
      )
    GROUP BY ae.user_id
  ), population AS (
    SELECT * FROM paid UNION ALL SELECT * FROM unpaid_opened
  ), counts AS (
    SELECT population.group_name, population.user_id, COUNT(lim.id)::int AS limit_count
    FROM population
    LEFT JOIN public.analytics_events lim ON lim.user_id = population.user_id
      AND lim.event_name IN ('daily_limit_reached','download_attempt_over_limit')
      AND lim.created_at <= population.anchor_at
    GROUP BY population.group_name, population.user_id
  )
  SELECT group_name, COUNT(*)::int AS users,
    AVG(limit_count)::float AS average,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY limit_count)::float AS median,
    COUNT(*) FILTER (WHERE limit_count = 1)::int AS bucket_1,
    COUNT(*) FILTER (WHERE limit_count BETWEEN 2 AND 3)::int AS bucket_2_3,
    COUNT(*) FILTER (WHERE limit_count BETWEEN 4 AND 5)::int AS bucket_4_5,
    COUNT(*) FILTER (WHERE limit_count >= 6)::int AS bucket_6_plus
  FROM counts
  GROUP BY group_name
  ORDER BY group_name`;

export async function getProductIntelligenceAnalytics(filters, excludedUserIds, queryFn) {
  const params = [filters.startAt, filters.endAt, filters.windowSeconds, excludedUserIds];
  const [reasons, timings, activity, comparison, retention, economics, rejection, failures, limitRepetition] = await Promise.all([
    queryFn(PRICING_REASON_SQL, [...params, [...PRICING_REASONS]]),
    queryFn(JOURNEY_TIMINGS_SQL, params),
    queryFn(ACTIVITY_CONVERSION_SQL, params),
    queryFn(BUYER_COMPARISON_SQL, params),
    queryFn(PAID_RETENTION_SQL, params),
    queryFn(SOURCE_ECONOMICS_SQL, params),
    queryFn(REJECTION_REASONS_SQL, params),
    queryFn(DOWNLOAD_FAILURES_SQL, params),
    queryFn(LIMIT_REPETITION_SQL, params)
  ]);
  const timing = timings.rows[0] || {};
  return {
    pricingOpenReasons: reasons.rows.map(row => ({
      reason: PRICING_REASONS.has(row.reason) ? row.reason : 'other',
      users: integer(row.users), events: integer(row.events)
    })),
    journeyTimings: {
      users: integer(timing.users),
      stages: [
        ['registration_to_download', timing.first_download_users, timing.registration_to_download_seconds],
        ['download_to_limit', timing.limit_users, timing.download_to_limit_seconds],
        ['limit_to_menu', timing.limit_users, timing.limit_to_menu_seconds],
        ['menu_to_plan', timing.plan_users, timing.menu_to_plan_seconds],
        ['plan_to_invoice', timing.invoice_users, timing.plan_to_invoice_seconds],
        ['invoice_to_payment', timing.payment_users, timing.invoice_to_payment_seconds]
      ].map(([stage, users, seconds]) => ({ stage, users: integer(users), averageSeconds: numeric(seconds) }))
    },
    activityConversion: activity.rows.map(row => ({
      segment: row.segment, users: integer(row.users), payers: integer(row.payers),
      conversion: percent(integer(row.payers), integer(row.users)), avgDownloads: numeric(row.avg_downloads)
    })),
    buyerComparison: comparison.rows.map(row => ({
      group: row.group_name, users: integer(row.users),
      avgAccountAgeDays: numeric(row.avg_account_age_days), avgDownloads: numeric(row.avg_downloads),
      reachedLimitUsers: integer(row.reached_limit_users), returnedUsers: integer(row.returned_users),
      avgActivityEvents: numeric(row.avg_activity_events)
    })),
    paidRetention: retention.rows.map(row => ({
      day: integer(row.day_number), eligible: integer(row.eligible), returned: integer(row.returned),
      rate: percent(integer(row.returned), integer(row.eligible))
    })),
    sourceEconomics: economics.rows.map(row => {
      const users = integer(row.users); const payers = integer(row.payers); const revenue = numeric(row.revenue_rub) || 0;
      return {
        source: row.source, users, payers, revenueRub: revenue,
        conversion: percent(payers, users), arpu: users ? revenue / users : null,
        arppu: payers ? revenue / payers : null, observedLtv: users ? revenue / users : null
      };
    }),
    rejectionReasons: rejection.rows.map(row => ({ reason: row.reason, users: integer(row.users) })),
    downloadFailures: failures.rows.map(row => ({
      reason: row.reason, source: row.source, events: integer(row.events), users: integer(row.users),
      openedMenuUsers: integer(row.opened_menu_users), selectedPlanUsers: integer(row.selected_plan_users),
      invoiceUsers: integer(row.invoice_users), payerUsers: integer(row.payer_users)
    })),
    limitRepetition: ['paid', 'opened_not_paid'].map(group => {
      const row = limitRepetition.rows.find(item => item.group_name === group);
      return {
        group,
        available: Boolean(row && integer(row.users) > 0),
        users: row ? integer(row.users) : 0,
        average: row ? numeric(row.average) : null,
        median: row ? numeric(row.median) : null,
        buckets: row ? {
          one: integer(row.bucket_1), twoToThree: integer(row.bucket_2_3),
          fourToFive: integer(row.bucket_4_5), sixPlus: integer(row.bucket_6_plus)
        } : null
      };
    })
  };
}

export const __productIntelligenceSql = Object.freeze({
  PRICING_REASON_SQL,
  JOURNEY_TIMINGS_SQL,
  ACTIVITY_CONVERSION_SQL,
  BUYER_COMPARISON_SQL,
  PAID_RETENTION_SQL,
  SOURCE_ECONOMICS_SQL,
  REJECTION_REASONS_SQL,
  DOWNLOAD_FAILURES_SQL,
  LIMIT_REPETITION_SQL
});
