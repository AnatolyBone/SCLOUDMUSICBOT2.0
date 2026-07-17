import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
process.env.CONFIG_SCOPE = 'database';

if (!process.env.DATABASE_URL) {
  console.error(JSON.stringify({ ok: false, error: 'DATABASE_URL is required.' }, null, 2));
  process.exit(1);
}
const { pool, query } = await import('../db.js');
const {
  ACQUISITION_SOURCES_SQL, RAW_SOURCES_SQL, RETENTION_SUMMARY_SQL,
  RETENTION_USERS_SQL, TIMELINE_SQL, getAcquisitionSourceExplorer,
  getRetentionExplorer, getUserTimeline
} = await import('../services/userInsightsService.js');

const isoDate = date => date.toISOString().slice(0, 10);
const bounds = (start, end) => [`${start}T00:00:00+03:00`, `${end}T23:59:59.999+03:00`];
const plan = async (client, mode, sql, params) => {
  const result = await client.query(`EXPLAIN (${mode}, FORMAT TEXT) ${sql}`, params);
  return result.rows.map(row => row['QUERY PLAN']);
};
const today = isoDate(new Date());
const startDate = isoDate(new Date(Date.now() - 29 * 86_400_000));
const [startAt, endAt] = bounds(startDate, today);
const fullStartAt = '1970-01-01T00:00:00+00:00';
let client;
try {
  const latest = await query('SELECT id FROM public.users ORDER BY created_at DESC, id DESC LIMIT 1');
  if (!latest.rows[0]) throw new Error('Integration database has no users.');
  const userId = String(latest.rows[0].id);
  const timeline = await getUserTimeline(userId, { startDate, endDate: today, limit: 50 });
  const retention = await getRetentionExplorer({ startDate, endDate: today });
  const returned = await getRetentionExplorer({ startDate, endDate: today, view: 'users', day: 7, segment: 'returned', limit: 50 });
  const notReturned = await getRetentionExplorer({ startDate, endDate: today, view: 'users', day: 7, segment: 'not_returned', limit: 50 });
  const sources = await getAcquisitionSourceExplorer({ startDate, endDate: today });

  client = await pool.connect();
  await client.query('BEGIN READ ONLY');
  await client.query(`SET LOCAL statement_timeout = '60s'`);
  const boundedAnalyze = {
    eventTimeline: await plan(client, 'ANALYZE, BUFFERS', TIMELINE_SQL, [userId, startAt, endAt, null, null, 51]),
    retentionAggregates: await plan(client, 'ANALYZE, BUFFERS', RETENTION_SUMMARY_SQL, [startAt, endAt, null]),
    retentionReturned: await plan(client, 'ANALYZE, BUFFERS', RETENTION_USERS_SQL, [startAt, endAt, null, 7, 'returned', 50, 0]),
    retentionNotReturnedToControlDay: await plan(client, 'ANALYZE, BUFFERS', RETENTION_USERS_SQL, [startAt, endAt, null, 7, 'not_returned', 50, 0]),
    sourceAnalytics: await plan(client, 'ANALYZE, BUFFERS', ACQUISITION_SOURCES_SQL, [startAt, endAt]),
    rawAndNormalizedSources: await plan(client, 'ANALYZE, BUFFERS', RAW_SOURCES_SQL, [startAt, endAt])
  };
  const fullEstimate = {
    eventTimeline: await plan(client, 'COSTS, VERBOSE', TIMELINE_SQL, [userId, null, null, null, null, 51]),
    retentionAggregates: await plan(client, 'COSTS, VERBOSE', RETENTION_SUMMARY_SQL, [fullStartAt, endAt, null]),
    retentionReturned: await plan(client, 'COSTS, VERBOSE', RETENTION_USERS_SQL, [fullStartAt, endAt, null, 7, 'returned', 50, 0]),
    retentionNotReturnedToControlDay: await plan(client, 'COSTS, VERBOSE', RETENTION_USERS_SQL, [fullStartAt, endAt, null, 7, 'not_returned', 50, 0]),
    sourceAnalytics: await plan(client, 'COSTS, VERBOSE', ACQUISITION_SOURCES_SQL, [fullStartAt, endAt]),
    rawAndNormalizedSources: await plan(client, 'COSTS, VERBOSE', RAW_SOURCES_SQL, [fullStartAt, endAt])
  };
  await client.query('ROLLBACK');
  const redactPlans = value => Object.fromEntries(Object.entries(value).map(([name, lines]) => [
    name,
    lines.filter(line => !line.startsWith('Query Identifier:'))
      .map(line => line.split(userId).join('[USER_ID]'))
  ]));
  const report = {
    ok: true, period: { startDate, endDate: today },
    verification: { userId: '[REDACTED]', timelineRows: timeline.events.length, timelineLimit: timeline.pagination.limit,
      retentionCohortSize: retention.summary.cohortSize, returnedRows: returned.users.length,
      notReturnedToControlDayRows: notReturned.users.length, sourceGroups: sources.sources.length,
      rawSourceGroups: sources.rawSources.length },
    plans: { boundedAnalyze: redactPlans(boundedAnalyze), fullEstimate: redactPlans(fullEstimate) }
  };
  const outputDir = path.join(process.cwd(), 'tmp');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'user-insights-integration.json');
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ...report, reportPath: outputPath }, null, 2));
} catch (error) {
  if (client) { try { await client.query('ROLLBACK'); } catch {} }
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
