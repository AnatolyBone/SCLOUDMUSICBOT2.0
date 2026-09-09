import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyticsDayRange,
  planStartupAnalyticsBackfill,
  selectAnalyticsBackfillCandidates,
  shiftAnalyticsDay
} from '../services/analyticsBackfillService.js';

test('analytics day range is inclusive and validates its explicit safety limit', () => {
  assert.deepEqual(analyticsDayRange('2026-08-19', '2026-08-27', 9), [
    '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23',
    '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27'
  ]);
  assert.throws(() => analyticsDayRange('2026-08-19', '2026-08-27', 8), /must not exceed 8 days/);
  assert.throws(() => analyticsDayRange('2026-02-30', '2026-03-01'), /valid calendar date/);
});

test('startup backfill begins at MAX(day) + 1 and ends at yesterday', () => {
  assert.deepEqual(planStartupAnalyticsBackfill('2026-08-18', '2026-08-26', 90), {
    status: 'ready',
    maxDayBefore: '2026-08-18',
    startDate: '2026-08-19',
    endDate: '2026-08-26',
    totalDays: 8,
    dates: ['2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23', '2026-08-24', '2026-08-25', '2026-08-26']
  });
});

test('startup backfill refuses an unexpectedly large automatic repair', () => {
  const plan = planStartupAnalyticsBackfill('2026-01-01', '2026-08-26', 90);
  assert.equal(plan.status, 'limit_exceeded');
  assert.equal(plan.dates.length, 0);
  assert.ok(plan.totalDays > 90);
});

test('date shifts use calendar UTC days without local timezone drift', () => {
  assert.equal(shiftAnalyticsDay('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftAnalyticsDay('2026-12-31', 1), '2027-01-01');
});

test('idempotent backfill skips existing aggregate days by default', () => {
  const days = [{ day: '2026-08-19', aggregated: true }, { day: '2026-08-20', aggregated: false }];
  assert.deepEqual(selectAnalyticsBackfillCandidates(days).map(row => row.day), ['2026-08-20']);
  assert.deepEqual(selectAnalyticsBackfillCandidates(days, false).map(row => row.day), ['2026-08-19', '2026-08-20']);
});
