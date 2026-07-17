import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';

const databaseUrl = process.env.PAYMENT_TEST_DATABASE_URL || process.env.DATABASE_URL;

if (!databaseUrl) {
  test('manual payment RPC integration requires PostgreSQL', {
    skip: 'Set PAYMENT_TEST_DATABASE_URL or DATABASE_URL.'
  }, () => {});
} else {
  test('process_manual_payment rejects direct manual Stars calls without writes', async () => {
    const { Client } = pg;
    const databaseHost = new URL(databaseUrl).hostname;
    const useSsl = !['localhost', '127.0.0.1', '::1'].includes(databaseHost);
    const client = new Client({
      connectionString: databaseUrl,
      ssl: useSsl ? { rejectUnauthorized: false } : false
    });

    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = '10s'`);
      const before = await client.query(
        `SELECT (SELECT COUNT(*) FROM public.payments)::bigint AS payments,
                (SELECT COUNT(*) FROM public.subscription_operations)::bigint AS operations`
      );

      const xtrResult = await client.query(
        `SELECT public.process_manual_payment($1, $2, $3, $4, $5, $6, $7, $8) AS result`,
        [0, 1, 'plus', 79, 'XTR', 'other_manual', 30, 'integration guard']
      );
      assert.deepEqual(xtrResult.rows[0].result, {
        status: 'validation_failed',
        reason: 'manual_stars_forbidden',
        error: 'Telegram Stars payments must be processed by process_stars_payment'
      });

      const methodResult = await client.query(
        `SELECT public.process_manual_payment($1, $2, $3, $4, $5, $6, $7, $8) AS result`,
        [0, 1, 'plus', 7900, 'RUB', 'telegram_stars', 30, 'integration guard']
      );
      assert.equal(methodResult.rows[0].result.status, 'validation_failed');
      assert.equal(methodResult.rows[0].result.reason, 'manual_stars_forbidden');

      const after = await client.query(
        `SELECT (SELECT COUNT(*) FROM public.payments)::bigint AS payments,
                (SELECT COUNT(*) FROM public.subscription_operations)::bigint AS operations`
      );
      assert.deepEqual(after.rows[0], before.rows[0]);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  });
}
