import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { notifyAdminAboutConfirmedStarsPayment } from '../services/starsPaymentNotificationService.js';

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

  test('confirmed Stars payment notification projection is PostgreSQL-compatible and idempotent', async (t) => {
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
      const payment = await client.query(
        `SELECT id, telegram_payment_charge_id
           FROM public.payments
          WHERE payment_status = 'completed'
            AND currency = 'XTR'
            AND telegram_payment_charge_id IS NOT NULL
          ORDER BY paid_at DESC, id DESC
          LIMIT 1`
      );
      if (!payment.rows[0]) {
        t.skip('No completed Telegram Stars payment is available for projection testing.');
        return;
      }

      const sent = [];
      const paymentRow = payment.rows[0];
      const first = await notifyAdminAboutConfirmedStarsPayment({
        paymentResult: { status: 'success', payment_id: paymentRow.id },
        paymentChargeId: paymentRow.telegram_payment_charge_id,
        adminId: 1,
        queryFn: (sql, params) => client.query(sql, params),
        sendMessage: async (...args) => {
          sent.push(args);
          return { message_id: 1 };
        }
      });
      const repeated = await notifyAdminAboutConfirmedStarsPayment({
        paymentResult: { status: 'already_processed', payment_id: paymentRow.id },
        paymentChargeId: paymentRow.telegram_payment_charge_id,
        adminId: 1,
        queryFn: (sql, params) => client.query(sql, params),
        sendMessage: async (...args) => sent.push(args)
      });

      const event = await client.query(
        `SELECT event_data
           FROM public.analytics_events
          WHERE deduplication_key = $1
          LIMIT 1`,
        [`payment_completed:${paymentRow.telegram_payment_charge_id}`]
      );
      assert.equal(first.sent, true);
      assert.deepEqual(repeated, { sent: false, reason: 'payment_not_new' });
      assert.equal(sent.length, 1);
      assert.equal(event.rows[0]?.event_data?.payment_provider, 'telegram_stars');
      assert.ok(Number(event.rows[0]?.event_data?.duration_days) > 0);
      assert.ok(Number(event.rows[0]?.event_data?.stars_amount) > 0);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  });
}
