import { backfillAnalyticsRange, pool } from '../db.js';
import { MANUAL_BACKFILL_MAX_DAYS, parseAnalyticsDay, shiftAnalyticsDay } from '../services/analyticsBackfillService.js';

function usage() {
  console.log('Usage: node scripts/backfill-analytics.js YYYY-MM-DD YYYY-MM-DD [--execute] [--include-current-day]');
  console.log('Without --execute the command is read-only and prints source-data coverage.');
  console.log('Existing analytics_daily rows are always skipped. Current/future Moscow days require --include-current-day.');
}

const args = process.argv.slice(2);
const positional = args.filter(arg => !arg.startsWith('--'));
if (positional.length !== 2 || args.includes('--help')) {
  usage();
  process.exit(positional.length === 2 ? 0 : 1);
}

const [startDate, endDate] = positional;
const execute = args.includes('--execute');

try {
  parseAnalyticsDay(startDate, 'startDate');
  parseAnalyticsDay(endDate, 'endDate');
  const todayMsk = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
  const latestCompleteDay = shiftAnalyticsDay(todayMsk, -1);
  if (execute && endDate > latestCompleteDay && !args.includes('--include-current-day')) {
    throw new Error(`endDate ${endDate} is not a completed Moscow day; use ${latestCompleteDay} or explicitly pass --include-current-day`);
  }

  const result = await backfillAnalyticsRange(startDate, endDate, {
    maxDays: MANUAL_BACKFILL_MAX_DAYS,
    skipExisting: true,
    dryRun: !execute
  });

  console.table(result.days.map(day => ({
    day: day.day,
    aggregated: day.aggregated ? 'yes' : 'NO',
    analytics_events: day.analytics_events,
    downloads: day.downloads,
    payments: day.payments,
    registrations: day.registrations
  })));
  console.log(JSON.stringify({
    mode: execute ? 'execute' : 'dry-run',
    candidates: result.candidates,
    restored: result.restored,
    failed: result.failed,
    maxDayBefore: result.maxDayBefore,
    maxDayAfter: result.maxDayAfter
  }, null, 2));

  if (!execute && result.candidates.length) {
    console.log('No database changes were made. Re-run with --execute only after reviewing this output.');
  }
  process.exitCode = result.failed.length ? 2 : 0;
} catch (error) {
  console.error(`[Analytics/Backfill CLI] ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
