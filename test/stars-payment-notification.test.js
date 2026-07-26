import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONFIRMED_STARS_PAYMENT_SQL,
  UPSERT_PAYMENT_COMPLETED_EVENT_SQL,
  formatStarsPaymentAdminNotification,
  notifyAdminAboutConfirmedStarsPayment
} from '../services/starsPaymentNotificationService.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function confirmedPaymentRow(overrides = {}) {
  return {
    payment_id: 42,
    user_id: '123456789',
    username: 'music_user',
    plan: 'unlim',
    amount_minor: '199',
    period_days: '30',
    subscription_expiration_date: '2026-08-25T12:00:00.000Z',
    last_source: 'soundcloud',
    total_payments: '5',
    referral_source: 'organic',
    language_code: 'ru',
    ...overrides
  };
}

test('Stars admin notification contains confirmed payment details and omits missing username', () => {
  const withUsername = formatStarsPaymentAdminNotification({
    paymentId: 42,
    userId: '123456789',
    username: 'music_user',
    tariff: 'unlim',
    starsAmount: 199,
    durationDays: 30,
    activeUntil: '2026-08-25T12:00:00.000Z',
    lastSource: 'soundcloud',
    totalPayments: 5
  });
  assert.match(withUsername, /Новая оплата/);
  assert.match(withUsername, /@music_user/);
  assert.match(withUsername, /Unlimited/);
  assert.match(withUsername, /199 Stars/);
  assert.match(withUsername, /30 дней/);
  assert.match(withUsername, /25\.08\.2026/);
  assert.match(withUsername, /SoundCloud/);
  assert.match(withUsername, /Всего оплат:<\/b>\n5/);

  const withoutUsername = formatStarsPaymentAdminNotification({
    userId: '987654321',
    username: null,
    tariff: 'plus',
    starsAmount: 79,
    durationDays: 30,
    activeUntil: '2026-08-25T12:00:00.000Z',
    lastSource: 'unknown',
    totalPayments: 1
  });
  assert.doesNotMatch(withoutUsername, /@\s*\n/);
  assert.match(withoutUsername, /ID: <code>987654321<\/code>/);
});

test('only a new RPC success sends one admin notification and enriches payment_completed', async () => {
  const calls = [];
  const messages = [];
  const queryFn = async (sql, params) => {
    calls.push({ sql, params });
    if (sql === CONFIRMED_STARS_PAYMENT_SQL) return { rows: [confirmedPaymentRow()] };
    if (sql === UPSERT_PAYMENT_COMPLETED_EVENT_SQL) return { rows: [], rowCount: 1 };
    throw new Error('Unexpected SQL');
  };
  const sendMessage = async (...args) => {
    messages.push(args);
    return { message_id: 1 };
  };

  const first = await notifyAdminAboutConfirmedStarsPayment({
    paymentResult: { status: 'success', payment_id: 42 },
    paymentChargeId: 'charge-42',
    adminId: 100500,
    queryFn,
    sendMessage
  });
  const repeated = await notifyAdminAboutConfirmedStarsPayment({
    paymentResult: { status: 'already_processed', payment_id: 42 },
    paymentChargeId: 'charge-42',
    adminId: 100500,
    queryFn,
    sendMessage
  });

  assert.equal(first.sent, true);
  assert.deepEqual(repeated, { sent: false, reason: 'payment_not_new' });
  assert.equal(messages.length, 1);
  assert.equal(messages[0][0], 100500);
  assert.equal(calls.length, 2);
  assert.match(calls[1].params[1], /"tariff":"unlim"/);
  assert.match(calls[1].params[1], /"duration_days":30/);
  assert.match(calls[1].params[1], /"payment_provider":"telegram_stars"/);
  assert.match(calls[1].params[1], /"stars_amount":199/);
});

test('notification SQL is parameterized and existing duration architecture stays order-driven', () => {
  const bot = fs.readFileSync(path.join(root, 'bot.js'), 'utf8');
  const tariffs = fs.readFileSync(path.join(root, 'config', 'tariffs.js'), 'utf8');
  const database = fs.readFileSync(path.join(root, 'db.js'), 'utf8');
  const rpc = fs.readFileSync(path.join(root, 'migrations', '006_analytics_system.sql'), 'utf8');

  assert.match(CONFIRMED_STARS_PAYMENT_SQL, /WHERE p\.id = \$1/);
  assert.doesNotMatch(CONFIRMED_STARS_PAYMENT_SQL, /\$\{[^}]+\}/);
  assert.match(bot, /periodDays: tariff\.periodDays/);
  assert.match(tariffs, /periodDays:\s*30/);
  assert.match(database, /period_days[\s\S]*periodDays/);
  assert.match(rpc, /v_order\.period_days \|\| ' days'/);
  assert.match(bot, /result && result\.status === 'success'[\s\S]{0,1200}notifyAdminAboutConfirmedStarsPayment/);
});
