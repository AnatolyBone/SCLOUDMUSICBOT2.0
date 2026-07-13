import { checkSchemaPreflight, pool } from '../db.js';
import { runAnalyticsSmokeTest } from './analyticsSmokeTest.js';
import { getWorkerHealth } from './workerManager.js';

function errorMessage(error) {
  return error?.details || error?.message || String(error);
}

async function runBroadcastDatabaseSmokeTest() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '10s'`);

    const userResult = await client.query('SELECT id FROM public.users ORDER BY id LIMIT 1');
    if (!userResult.rows[0]) {
      throw new Error('Broadcast smoke requires at least one user row.');
    }

    const taskId = -(Date.now() * 1000 + Math.floor(Math.random() * 1000));
    const logId = taskId - 1;
    await client.query(
      `INSERT INTO public.broadcast_tasks (
         id, message, target_audience, scheduled_at, status, target_languages,
         unknown_language_policy, messages_json, language_source_filter, fallback_language
       ) VALUES (
         $1, 'admin self-test', 'all_users', NOW(), 'processing', ARRAY['all'],
         'use_ru', '{"ru":{"message":"admin self-test"}}'::jsonb, 'all', 'ru'
       )`,
      [taskId]
    );

    await client.query(
      `INSERT INTO public.broadcast_log (
         id, broadcast_id, user_id, audience_language_segment, delivered_language, status
       ) VALUES ($1, $2, $3, 'ru', 'ru', 'pending')`,
      [logId, taskId, userResult.rows[0].id]
    );
    await client.query(
      `UPDATE public.broadcast_log SET status = 'sent', sent_at = NOW()
       WHERE broadcast_id = $1 AND status = 'pending'`,
      [taskId]
    );
    await client.query(
      `UPDATE public.broadcast_tasks SET status = 'completed', completed_at = NOW()
       WHERE id = $1`,
      [taskId]
    );

    const stateResult = await client.query(
      `SELECT t.status, t.completed_at,
              COUNT(l.*)::int AS targeted_count,
              COUNT(l.*) FILTER (WHERE l.status = 'sent')::int AS sent_count
       FROM public.broadcast_tasks t
       LEFT JOIN public.broadcast_log l ON l.broadcast_id = t.id
       WHERE t.id = $1
       GROUP BY t.id`,
      [taskId]
    );
    const state = stateResult.rows[0];
    if (state.status !== 'completed' || !state.completed_at || state.targeted_count !== 1 || state.sent_count !== 1) {
      throw new Error('Broadcast lifecycle SQL smoke did not reach the completed state.');
    }

    return { lifecycle: 'pending -> sent -> completed', sentCount: state.sent_count, rolledBack: true };
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

export async function runSystemSelfTest() {
  const startedAt = Date.now();
  const statuses = {
    database: 'error',
    analytics: 'error',
    broadcasts: 'error',
    workers: 'error',
    excel: 'error'
  };
  const details = {};

  try {
    const schema = await checkSchemaPreflight({ throwOnMissing: true });
    await pool.query('SELECT 1 AS ok');
    statuses.database = 'ok';
    details.database = { summary: schema.summary, schemaVersion: schema.schemaVersion };
  } catch (error) {
    details.database = { error: errorMessage(error) };
  }

  try {
    details.broadcasts = await runBroadcastDatabaseSmokeTest();
    statuses.broadcasts = 'ok';
  } catch (error) {
    details.broadcasts = { error: errorMessage(error) };
  }

  try {
    const analytics = await runAnalyticsSmokeTest();
    details.analytics = analytics;
    statuses.analytics = analytics.ok ? 'ok' : 'error';
    statuses.excel = analytics.tests?.excel_generation?.status === 'ok' ? 'ok' : 'error';
    details.excel = analytics.tests?.excel_generation || { error: 'Excel smoke result is missing.' };
  } catch (error) {
    details.analytics = { error: errorMessage(error) };
    details.excel = { error: errorMessage(error) };
  }

  const workerHealth = getWorkerHealth();
  statuses.workers = workerHealth.ok ? 'ok' : 'error';
  details.workers = workerHealth;

  const ok = Object.values(statuses).every(status => status === 'ok');
  return {
    ok,
    ...statuses,
    durationMs: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
    details
  };
}
