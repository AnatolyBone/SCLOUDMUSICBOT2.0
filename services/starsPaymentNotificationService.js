function toSafeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPlanName(plan) {
  const names = {
    plus: 'Plus',
    pro: 'Pro',
    unlim: 'Unlimited'
  };
  return names[String(plan || '').toLowerCase()] || String(plan || 'Unknown');
}

function formatSource(source) {
  const names = {
    soundcloud: 'SoundCloud',
    spotify: 'Spotify',
    youtube: 'YouTube',
    youtube_music: 'YouTube Music',
    cache: 'Кэш',
    unknown: 'Неизвестно'
  };
  const normalized = String(source || 'unknown').trim().toLowerCase();
  return names[normalized] || String(source || 'Неизвестно');
}

function formatMoscowDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
}

export const CONFIRMED_STARS_PAYMENT_SQL = `
  SELECT p.id AS payment_id,
         p.user_id,
         p.plan,
         p.amount_minor,
         p.period_days,
         p.subscription_expiration_date,
         u.username,
         u.referral_source,
         COALESCE(u.language_code, u.lang) AS language_code,
         COALESCE((
           SELECT NULLIF(dl.source, '')
             FROM public.downloads_log dl
            WHERE dl.user_id = p.user_id
            ORDER BY dl.downloaded_at DESC, dl.id DESC
            LIMIT 1
         ), (
           SELECT NULLIF(ae.event_data->>'source', '')
             FROM public.analytics_events ae
            WHERE ae.user_id = p.user_id
              AND ae.event_name = 'track_download_success'
            ORDER BY ae.created_at DESC, ae.id DESC
            LIMIT 1
         ), 'unknown') AS last_source,
         (SELECT COUNT(*)::int
            FROM public.payments paid
           WHERE paid.user_id = p.user_id
             AND paid.payment_status = 'completed') AS total_payments
    FROM public.payments p
    JOIN public.users u ON u.id = p.user_id
   WHERE p.id = $1
     AND p.payment_status = 'completed'
   LIMIT 1`;

export const UPSERT_PAYMENT_COMPLETED_EVENT_SQL = `
  INSERT INTO public.analytics_events (
    user_id, event_name, event_category, event_data, event_origin,
    acquisition_source, placement, language_code, deduplication_key
  ) VALUES (
    $1, 'payment_completed', 'monetization', $2::jsonb, 'live',
    $3, 'telegram_successful_payment', $4, $5
  )
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL
  DO UPDATE SET event_data = COALESCE(public.analytics_events.event_data, '{}'::jsonb)
                              || EXCLUDED.event_data`;

export async function getConfirmedStarsPaymentSummary(paymentId, queryFn) {
  if (!paymentId) throw new Error('paymentId is required');
  if (typeof queryFn !== 'function') throw new Error('queryFn is required');
  const result = await queryFn(CONFIRMED_STARS_PAYMENT_SQL, [paymentId]);
  const row = result.rows?.[0];
  if (!row) throw new Error('Confirmed Stars payment was not found');
  return {
    paymentId: row.payment_id,
    userId: String(row.user_id),
    username: row.username || null,
    tariff: String(row.plan || ''),
    starsAmount: toSafeInteger(row.amount_minor),
    durationDays: toSafeInteger(row.period_days),
    activeUntil: row.subscription_expiration_date,
    lastSource: row.last_source || 'unknown',
    totalPayments: toSafeInteger(row.total_payments),
    referralSource: row.referral_source || null,
    languageCode: row.language_code || null
  };
}

export function formatStarsPaymentAdminNotification(summary) {
  const userLines = summary.username
    ? [`@${escapeHtml(String(summary.username).replace(/^@/, ''))}`, `ID: <code>${escapeHtml(summary.userId)}</code>`]
    : [`ID: <code>${escapeHtml(summary.userId)}</code>`];

  return [
    '💰 <b>Новая оплата!</b>',
    '',
    '👤 <b>Пользователь:</b>',
    ...userLines,
    '',
    '⭐ <b>Тариф:</b>',
    escapeHtml(formatPlanName(summary.tariff)),
    '',
    '💎 <b>Оплата:</b>',
    `${toSafeInteger(summary.starsAmount)} Stars`,
    '',
    '📅 <b>Срок:</b>',
    `${toSafeInteger(summary.durationDays)} дней`,
    '',
    '⏰ <b>Активен до:</b>',
    formatMoscowDate(summary.activeUntil),
    '',
    '📥 <b>Последний источник:</b>',
    escapeHtml(formatSource(summary.lastSource)),
    '',
    '📊 <b>Всего оплат:</b>',
    String(toSafeInteger(summary.totalPayments))
  ].join('\n');
}

export async function upsertPaymentCompletedAnalytics(summary, paymentChargeId, queryFn) {
  const eventData = {
    tariff: summary.tariff,
    duration_days: summary.durationDays,
    payment_provider: 'telegram_stars',
    stars_amount: summary.starsAmount,
    payment_id: summary.paymentId
  };
  await queryFn(UPSERT_PAYMENT_COMPLETED_EVENT_SQL, [
    summary.userId,
    JSON.stringify(eventData),
    summary.referralSource,
    summary.languageCode,
    `payment_completed:${paymentChargeId}`
  ]);
}

export async function notifyAdminAboutConfirmedStarsPayment({
  paymentResult,
  paymentChargeId,
  adminId,
  queryFn,
  sendMessage
}) {
  if (paymentResult?.status !== 'success' || !paymentResult.payment_id) {
    return { sent: false, reason: 'payment_not_new' };
  }
  if (!paymentChargeId) throw new Error('paymentChargeId is required');
  if (!adminId) throw new Error('adminId is required');
  if (typeof sendMessage !== 'function') throw new Error('sendMessage is required');

  const summary = await getConfirmedStarsPaymentSummary(paymentResult.payment_id, queryFn);
  try {
    await upsertPaymentCompletedAnalytics(summary, paymentChargeId, queryFn);
  } catch (error) {
    console.warn('[Payment/AdminNotify] payment_completed enrichment failed:', error.message);
  }

  await sendMessage(adminId, formatStarsPaymentAdminNotification(summary), {
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
  return { sent: true, summary };
}
