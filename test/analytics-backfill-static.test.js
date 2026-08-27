import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbSource = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
const cliSource = fs.readFileSync(path.join(ROOT, 'scripts', 'backfill-analytics.js'), 'utf8');

test('daily scheduler catches up after 00:05 and marks completion only after aggregation succeeds', () => {
  const scheduler = indexSource.slice(indexSource.indexOf('const aggregationRetryMs'), indexSource.indexOf('// Разовый запуск сброса подписок'));
  assert.match(scheduler, /afterScheduledTime/);
  assert.match(scheduler, /aggregationRetryMs/);
  assert.ok(scheduler.indexOf('await aggregateDailyStats(targetDay)') < scheduler.indexOf('lastAggregationDate = targetDay'));
  assert.doesNotMatch(scheduler, /hh === 0 && mm === 5/);
});

test('startup backfill derives its range from MAX(day) and manual backfill is idempotent', () => {
  assert.match(dbSource, /SELECT MAX\(day\)::text AS max_day FROM analytics_daily/);
  assert.match(dbSource, /planStartupAnalyticsBackfill\(maxDayBefore, yesterdayMsk, maxDays\)/);
  assert.match(dbSource, /ON CONFLICT \(day\) DO UPDATE/);
  assert.match(dbSource, /pg_try_advisory_xact_lock/);
  assert.match(cliSource, /dryRun: !execute/);
  assert.match(cliSource, /skipExisting: true/);
});
