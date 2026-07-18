import {
  checkSchemaPreflight,
  estimateBroadcastAudience,
  getAIRecommendationsData,
  getAllBroadcastTasks,
  getAppSettings,
  getBroadcastTaskStats,
  getCohortRetentionData,
  getExcelAnalyticsData,
  getPeriodComparisonData,
  getRevenueDashboardData,
  query
} from '../db.js';
import { generateExcelReport } from './excelReportService.js';
import {
  getAcquisitionSourceExplorer,
  getRetentionExplorer,
  getUserTimeline
} from './userInsightsService.js';
import { getPaymentLossAnalytics, getPaymentLossUsers } from './paymentLossAnalyticsService.js';

function moscowDate(daysAgo = 0) {
  return new Date(Date.now() - daysAgo * 86_400_000)
    .toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
}

function errorMessage(error) {
  return error?.details || error?.message || String(error);
}

export async function runAnalyticsSmokeTest() {
  const today = moscowDate();
  const yesterday = moscowDate(1);
  const tests = {};

  const run = async (name, test) => {
    const startedAt = Date.now();
    try {
      const details = await test();
      tests[name] = {
        status: 'ok',
        durationMs: Date.now() - startedAt,
        ...(details === undefined ? {} : { details })
      };
    } catch (error) {
      tests[name] = {
        status: 'error',
        durationMs: Date.now() - startedAt,
        error: errorMessage(error)
      };
    }
  };

  await run('schema_preflight', async () => {
    const result = await checkSchemaPreflight({ throwOnMissing: true });
    return result.summary;
  });

  await run('analytics_dashboard', async () => {
    const params = [yesterday, today];
    const results = await Promise.all([
      query(
        `SELECT day, dau, wau, mau, registrations, downloads_total,
                downloads_from_cache, downloads_new, limits_reached,
                tariffs_shown, tariffs_clicked, payments_started,
                payments_completed, revenue_rub_minor, revenue_xtr, updated_at
         FROM public.analytics_daily
         WHERE day BETWEEN $1 AND $2
         ORDER BY day DESC
         LIMIT 7`,
        params
      ),
      query(
        `SELECT MAX(updated_at) AS last_update, MIN(day) AS min_day, MAX(day) AS max_day
         FROM public.analytics_daily`
      ),
      query(
        `SELECT COALESCE(SUM(tariffs_shown), 0)::int AS total_shown,
                COALESCE(SUM(tariffs_clicked), 0)::int AS total_clicked,
                COALESCE(SUM(payments_started), 0)::int AS total_started,
                COALESCE(SUM(payments_completed), 0)::int AS total_completed,
                COALESCE(SUM(revenue_rub_minor), 0)::bigint AS total_rev_rub,
                COALESCE(SUM(revenue_xtr), 0)::bigint AS total_rev_xtr
         FROM public.analytics_daily
         WHERE day BETWEEN $1 AND $2`,
        params
      ),
      query(
        `SELECT downloads_count, COUNT(*)::int AS users_count
         FROM public.analytics_user_daily
         WHERE day BETWEEN $1 AND $2 AND downloads_count > 0
         GROUP BY downloads_count
         ORDER BY downloads_count
         LIMIT 20`,
        params
      ),
      query(
        `SELECT COUNT(DISTINCT user_id)::int AS count
         FROM public.analytics_events
         WHERE event_name IN ('daily_limit_reached', 'download_attempt_over_limit')
           AND created_at BETWEEN $1::date AND ($2::date + 1)`,
        params
      ),
      query(
        `SELECT COUNT(DISTINCT p.user_id)::int AS count
         FROM public.payments p
         JOIN public.analytics_events e
           ON e.user_id = p.user_id
          AND e.event_name = 'daily_limit_reached'
          AND e.created_at < p.paid_at
         WHERE p.payment_status = 'completed'
           AND p.paid_at BETWEEN $1::date AND ($2::date + 1)`,
        params
      )
    ]);
    return { queries: results.length };
  });

  await run('period_comparison', async () => {
    await getPeriodComparisonData(today, today, yesterday, yesterday);
  });
  await run('cohort_analysis', async () => {
    const rows = await getCohortRetentionData();
    return { rows: rows.length };
  });
  await run('user_timeline', async () => {
    const userResult = await query('SELECT id FROM public.users ORDER BY created_at DESC, id DESC LIMIT 1');
    if (!userResult.rows[0]) return { rows: 0 };
    const timeline = await getUserTimeline(userResult.rows[0].id, { limit: 5 });
    return { rows: timeline?.events.length || 0 };
  });
  await run('retention_explorer', async () => {
    const summary = await getRetentionExplorer({ startDate: yesterday, endDate: today });
    const users = await getRetentionExplorer({
      startDate: yesterday, endDate: today, view: 'users', day: 1,
      segment: 'all', limit: 1
    });
    return { cohortSize: summary.summary.cohortSize, users: users.users.length };
  });
  await run('acquisition_sources', async () => {
    const sources = await getAcquisitionSourceExplorer({ startDate: yesterday, endDate: today });
    return { rows: sources.sources.length };
  });
  await run('payment_loss_analytics', async () => {
    const report = await getPaymentLossAnalytics({ startDate: yesterday, endDate: today, window: '24h' });
    const users = await getPaymentLossUsers({
      startDate: yesterday, endDate: today, window: '24h', stage: 'menu', limit: 1
    });
    if (!report.derivedMetrics || !Array.isArray(report.eventContract) || !report.downloadContext
        || !report.productIntelligence || !Array.isArray(report.productIntelligence.paidRetention)) {
      throw new Error('Payment-loss analytics response is incomplete.');
    }
    return {
      stages: report.funnel.length,
      plans: report.plans.length,
      segments: report.segments.length,
      sources: report.contentSources.length,
      eventContractRows: report.eventContract.length,
      pricingReasons: report.productIntelligence.pricingOpenReasons.length,
      paidRetentionRows: report.productIntelligence.paidRetention.length,
      users: users.users.length
    };
  });
  await run('revenue_dashboard', async () => {
    await getRevenueDashboardData(yesterday, today);
  });
  await run('growth_assistant', async () => {
    await getAIRecommendationsData();
  });
  await run('excel_data_query', async () => {
    await getExcelAnalyticsData(yesterday, today);
  });
  await run('excel_generation', async () => {
    const data = await getExcelAnalyticsData(today, today);
    const artifact = await generateExcelReport(data, { startDate: today, endDate: today });
    try {
      return { bytes: artifact.size };
    } finally {
      await artifact.cleanup();
    }
  });
  await run('broadcast_list', async () => {
    const rows = await getAllBroadcastTasks({ limit: 5 });
    return { rows: rows.length };
  });
  await run('broadcast_stats', async () => {
    const latest = await query('SELECT id FROM broadcast_tasks ORDER BY id DESC LIMIT 1');
    await getBroadcastTaskStats(latest.rows[0]?.id ?? -1);
  });
  await run('broadcast_audience_estimate', async () => {
    await estimateBroadcastAudience('all_users', ['all'], 'use_ru', 'all', {
      ru: { message: 'schema smoke test' },
      en: { message: 'schema smoke test' }
    });
  });
  await run('user_language_profile', async () => {
    await query(
      `SELECT id, language_code, language_source, telegram_language_code, language_updated_at
       FROM users
       ORDER BY id
       LIMIT 1`
    );
  });
  await run('language_history', async () => {
    await query(
      `SELECT id, user_id, previous_language, new_language, previous_source,
              new_source, changed_by_type, changed_by_user_id, created_at
       FROM language_history
       ORDER BY created_at DESC
       LIMIT 1`
    );
  });
  await run('redirect_click_query', async () => {
    await query(
      `SELECT id, campaign_id, user_id, button_index, clicked_at, user_agent, language_code
       FROM broadcast_clicks
       WHERE campaign_id = $1
       ORDER BY clicked_at DESC
       LIMIT 1`,
      [-1]
    );
  });
  await run('payments_query', async () => {
    await query(
      `SELECT id, user_id, plan, amount_minor, currency, payment_method,
              payment_status, telegram_payment_charge_id, provider_payment_charge_id,
              invoice_payload, is_recurring, is_first_recurring,
              subscription_expiration_date, period_days, comment, metadata,
              created_at, paid_at
       FROM payments
       WHERE paid_at >= NOW() - INTERVAL '2 days' OR paid_at IS NULL
       ORDER BY created_at DESC
       LIMIT 5`
    );
  });
  await run('settings_query', async () => {
    const settings = await getAppSettings();
    return { rows: Object.keys(settings).length };
  });

  const passed = Object.values(tests).filter(test => test.status === 'ok').length;
  const failed = Object.keys(tests).length - passed;
  return {
    ok: failed === 0,
    summary: { passed, failed },
    tests
  };
}
