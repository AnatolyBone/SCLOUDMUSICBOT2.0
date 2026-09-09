import test from 'node:test';
import assert from 'node:assert/strict';
import { averageAvailable, comparableHalfTrend, markActivityAvailability, previousDayPercentDelta, resolveReportPeriod } from '../services/analyticsReportSemantics.js';

test('report endDate is the last actually included aggregate date', () => {
  assert.deepEqual(resolveReportPeriod('2026-07-06', '2026-08-05', '2026-08-02'), {
    requestedStartDate:'2026-07-06', requestedEndDate:'2026-08-05', startDate:'2026-07-06', endDate:'2026-08-02', isTruncated:true,
    truncationReason:'analytics_daily_missing_after_end', analyticsDailyMissingAfter:'2026-08-02'
  });
});

test('days before activity telemetry are unavailable rather than zero and averages exclude them', () => {
  const rows = markActivityAvailability([{day:'2026-07-12',dau:0},{day:'2026-07-13',dau:10},{day:'2026-07-14',dau:20}], '2026-07-13');
  assert.equal(rows[0].dau, null);
  assert.equal(averageAvailable(rows, 'dau'), 15);
});

test('trend is unavailable for incomplete non-comparable samples', () => {
  assert.equal(comparableHalfTrend([{dau:null},{dau:10},{dau:20}], 'dau'), null);
  assert.equal(comparableHalfTrend([{dau:10},{dau:10},{dau:20},{dau:20}], 'dau'), 1);
});

test('daily deltas are day-over-day percentages and never bridge unavailable or zero baselines', () => {
  assert.equal(previousDayPercentDelta(242, 158), 242 / 158 - 1);
  assert.equal(previousDayPercentDelta(10, null), null);
  assert.equal(previousDayPercentDelta(199, 0), null);
  assert.equal(previousDayPercentDelta(0, 199), -1);
});

test('report SQL contract separates usage from monetization and excludes all-time users from funnel', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../db.js', import.meta.url), 'utf8'));
  assert.match(source, /const usage = \[/);
  assert.match(source, /const funnel = legacyFunnel\.slice\(3\)/);
  assert.match(source, /legacyFunnel\.slice\(3\)/);
  assert.match(source, /COUNT\(DISTINCT user_id\)/);
  assert.match(source, /limit_users[\s\S]*tariff_users[\s\S]*started_users[\s\S]*paid_users/);
  assert.match(source, /AT TIME ZONE 'Europe\/Moscow'/);
});

test('payment totals keep formulas and cached values for viewers without recalculation', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../scripts/generate_excel_report.py', import.meta.url), 'utf8'));
  assert.match(source, /SUMPRODUCT\(\(D6:D\{payment_last_row\}=\"RUB\"\)\*E6:E\{payment_last_row\}\*G6:G\{payment_last_row\}\)/);
  assert.match(source, /currency_format, rub_total/);
  assert.match(source, /stars_format, stars_total/);
});
