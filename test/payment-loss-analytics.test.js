import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  __paymentLossSql,
  getPaymentLossAnalytics,
  getPaymentLossUsers,
  validatePaymentLossFilters
} from '../services/paymentLossAnalyticsService.js';

test('payment-loss filters accept only fixed conversion windows and bounded dates', () => {
  assert.equal(validatePaymentLossFilters({ startDate: '2026-07-01', endDate: '2026-07-17', window: '7d' }).windowSeconds, 604800);
  assert.equal(validatePaymentLossFilters({ startDate: '2026-07-01', endDate: '2026-07-17', window: 'DROP TABLE' }).window, '24h');
  assert.throws(() => validatePaymentLossFilters({ startDate: '2026-07-18', endDate: '2026-07-17' }), /startDate/);
  assert.throws(() => validatePaymentLossFilters({ startDate: '2024-01-01', endDate: '2026-07-17' }), /366/);
});

test('repeated opens count once while invoice and pre-checkout dropouts remain distinct', async () => {
  const rows = [
    [{ menu_users: 100, plan_users: 60, invoice_users: 50, checkout_users: 40, payment_users: 10,
       menu_events: 150, plan_events: 80, invoice_events: 55, checkout_events: 42, payment_events: 10 }],
    [{ plan: 'pro', selected_users: 60, invoice_users: 50, checkout_users: 40, payment_users: 10,
       avg_seconds_to_payment: '600', avg_downloads_before: '2.5', reached_limit_users: 12 }],
    [{ opened_users: 20, paid_24h_users: 2, paid_7d_users: 4 }],
    [{ unpaid_users: 90, downloaded_again: 30, no_observed_activity: 10 }],
    [{ segment: 'Достигли лимита', users: 30, payers: 6 }],
    [{ content_source: 'SoundCloud', entry_source: 'Direct URL', users: 40, successful_downloads: 90, errors: 0,
       limit_users: 12, selected_users: 30, invoice_users: 25, checkout_users: 20, payers: 8, returned_d1: 9, returned_d7: 3 }],
    [{ error_category: 'Провайдер оплаты', users: 3, events: 4 }],
    [{ method: 'Т-Банк / СБП', opened_users: 10, request_events: 13, paid_24h_users: 2, paid_7d_users: 3, avg_seconds_to_payment: 900 }],
    [{ median_seconds_to_payment: 500, avg_downloads_before_purchase: 4.5, avg_days_registration_to_payment: 12,
       limit_users: 50, limit_to_menu_users: 20, limit_to_payment_users: 5 }],
    [{ menu_after_success: 80, menu_after_error: 0, paid_after_success: 10, paid_after_error: 0,
       both_success_and_error: 0, error_events: 0, successful_downloads: 150 }],
    [{ event_name: 'star_payment_option_shown', events: 150, users: 100, has_plan: false, has_placement: true,
       has_order_id: false, has_payment_method: false, has_source: false, has_deduplication_key: false }],
    [{ reason: 'daily_limit', users: 50, events: 70 }],
    [{ users: 100, first_download_users: 90, limit_users: 50, plan_users: 60, invoice_users: 50, payment_users: 10,
       registration_to_download_seconds: 3600, download_to_limit_seconds: 86400, limit_to_menu_seconds: 180,
       menu_to_plan_seconds: 20, plan_to_invoice_seconds: 10, invoice_to_payment_seconds: 60 }],
    [{ segment: '6–20', users: 40, payers: 8, avg_downloads: 12 }],
    [{ group_name: 'buyers', users: 10, avg_account_age_days: 12, avg_downloads: 20, reached_limit_users: 8, returned_users: 6, avg_activity_events: 30 }],
    [{ day_number: 7, eligible: 10, returned: 4 }],
    [{ source: 'organic', users: 100, payers: 10, revenue_rub: 2000 }],
    [{ reason: 'invoice_without_pre_checkout', users: 10 }],
    [{ reason: 'timeout', source: 'youtube', events: 4, users: 3, opened_menu_users: 2, selected_plan_users: 1, invoice_users: 1, payer_users: 1 }],
    [{ group_name: 'paid', users: 5, average: 2.4, median: 2, bucket_1: 2, bucket_2_3: 2, bucket_4_5: 1, bucket_6_plus: 0 }]
  ];
  let call = 0;
  const report = await getPaymentLossAnalytics(
    { startDate: '2026-07-17', endDate: '2026-07-17', window: '24h' },
    { queryFn: async (sql, params) => {
      assert.match(sql, /\$1/); assert.ok(Array.isArray(params));
      return { rows: rows[call++] };
    } }
  );
  assert.equal(report.funnel[0].users, 100);
  assert.equal(report.funnel[0].events, 150);
  assert.equal(report.funnel[1].dropoutUsers, 40);
  assert.equal(report.funnel[1].dropoutPercent, 40);
  assert.equal(report.funnel[3].dropoutUsers, 10);
  assert.equal(report.funnel[4].dropoutUsers, 30);
  assert.equal(report.funnel[4].events, 10);
  assert.equal(report.plans[0].conversion, 16.67);
  assert.equal(report.alternative.conversion7d, 20);
  assert.equal(report.contentSources[0].conversion, 20);
  assert.equal(report.contentSources[0].errors, 0);
  assert.equal(report.paymentErrors[0].events, 4);
  assert.equal(report.alternative.methods[0].requestEvents, 13);
  assert.equal(report.derivedMetrics.limitToPaymentConversion, 10);
  assert.equal(report.downloadContext.errorTelemetryAvailable, true);
  assert.equal(report.eventContract[0].fields.placement, true);
  assert.equal(report.productIntelligence.pricingOpenReasons[0].reason, 'daily_limit');
  assert.equal(report.productIntelligence.paidRetention[0].rate, 40);
  assert.equal(report.productIntelligence.sourceEconomics[0].arpu, 20);
  assert.equal(report.productIntelligence.downloadFailures[0].openedMenuUsers, 2);
  assert.equal(report.productIntelligence.downloadFailures[0].invoiceUsers, 1);
  assert.equal(report.productIntelligence.limitRepetition[0].average, 2.4);
  assert.equal(report.recommendations.length, 1);
});

test('period before complete telemetry returns n/a conversions instead of false zeroes', async () => {
  const emptyResults = Array.from({ length: 20 }, () => ({ rows: [] }));
  emptyResults[0] = { rows: [{ menu_users: 10, plan_users: 0, menu_events: 10, plan_events: 0 }] };
  let call = 0;
  const report = await getPaymentLossAnalytics(
    { startDate: '2026-07-01', endDate: '2026-07-16', window: '24h' },
    { queryFn: async () => emptyResults[call++] }
  );
  assert.equal(report.dataCompleteness.isCompleteRange, false);
  assert.equal(report.funnel[1].conversionFromPrevious, null);
  assert.equal(report.funnel[1].dropoutUsers, null);
  assert.equal(report.derivedMetrics.menuToPlanCtr, null);
  assert.equal(report.downloadContext.menuAfterError, null);
  assert.equal(report.downloadContext.errorTelemetryAvailable, false);
  assert.equal(report.recommendations.length, 0);
});

test('attribution SQL is read-only, parameterized and assigns one anchor per user', () => {
  for (const sql of Object.values(__paymentLossSql)) {
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER)\b/i);
    assert.match(sql, /\$\d/);
  }
  assert.match(__paymentLossSql.FUNNEL_SQL, /ROW_NUMBER\(\) OVER/);
  assert.match(__paymentLossSql.FUNNEL_SQL, /PARTITION BY m\.user_id/);
  assert.match(__paymentLossSql.FUNNEL_SQL, /payment_status = 'completed'/);
  assert.match(__paymentLossSql.FUNNEL_SQL, /NOT \(ae\.user_id = ANY\(\$4::bigint\[\]\)\)/);
  assert.match(__paymentLossSql.ALTERNATIVE_DETAIL_SQL, /payment_status = 'completed'/);
  assert.match(__paymentLossSql.ALTERNATIVE_DETAIL_SQL, /currency = 'RUB'/);
  assert.match(__paymentLossSql.DERIVED_METRICS_SQL, /PERCENTILE_CONT\(0\.5\)/);
  assert.match(__paymentLossSql.CONTENT_SOURCE_SQL, /returned_d1/);
  assert.match(__paymentLossSql.DOWNLOAD_CONTEXT_SQL, /track_download_failed/);
  assert.match(__paymentLossSql.FUNNEL_SQL, /p\.paid_at <= m\.menu_at \+ make_interval\(secs => \$3::int\)/);
  assert.match(__paymentLossSql.ALTERNATIVE_DETAIL_SQL, /p\.paid_at BETWEEN choice\.opened_at AND choice\.opened_at \+ interval '7 days'/);
  assert.match(__paymentLossSql.DRILLDOWN_STAGE_SQL, /last_tariff_step/);
  assert.match(__paymentLossSql.DRILLDOWN_STAGE_SQL, /payment_errors/);
});

test('drilldown clamps page size and rejects arbitrary stage SQL', async () => {
  let captured;
  const result = await getPaymentLossUsers(
    { startDate: '2026-07-17', endDate: '2026-07-17', stage: 'created_at DESC; DROP TABLE users', limit: 9999 },
    { queryFn: async (_sql, params) => { captured = params; return { rows: [] }; } }
  );
  assert.equal(result.stage, 'menu');
  assert.equal(result.limit, 200);
  assert.equal(captured[4], 'menu');
  assert.equal(captured[5], 200);
});

test('payment-loss endpoints remain protected by admin auth', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.match(source, /app\.get\('\/admin\/analytics\/payment-loss', requireAuth/);
  assert.match(source, /app\.get\('\/admin\/analytics\/payment-loss\/users', requireAuth/);
});
