import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildLimitUpsell, buildUpgradeOffer } from '../services/limitUpsellService.js';
import {
  INVOICE_REQUEST_COOLDOWN_MS,
  acquireInvoiceRequest,
  clearInvoiceRequestGuard,
  releaseInvoiceRequest
} from '../services/paymentInvoiceGuard.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('limit upsell keeps the subscription bonus and always exposes the tariff action in RU and EN', () => {
  const freeUser = { downloads_today: 3, premium_until: null, premium_limit: 3 };
  const ru = buildLimitUpsell({
    lang: 'ru', channelUsername: '@SCM_BLOG', bonusAvailable: true, user: freeUser, freeLimit: 3
  });
  const en = buildLimitUpsell({
    lang: 'en', channelUsername: '@SCM_BLOG', bonusAvailable: true, user: freeUser, freeLimit: 3
  });

  for (const payload of [ru, en]) {
    const callbacks = payload.extra.reply_markup.inline_keyboard.flat().map(button => button.callback_data);
    assert.deepEqual(callbacks, [
      'buy_plan_plus', 'buy_plan_pro', 'buy_plan_unlim', 'other_payment_methods', 'check_subscription'
    ]);
    assert.match(payload.text, /SCM_BLOG/);
    assert.match(payload.text, /Plus/);
    assert.match(payload.text, /Pro/);
    assert.match(payload.text, /Unlimited/);
  }
  assert.match(ru.text, /Бесплатный дневной лимит исчерпан: 3 загрузки/);
  assert.match(en.text, /all 3 free downloads/);
  assert.doesNotMatch(en.text, /₽|руб|RUB/i);
});

test('paid-plan limit message uses the actual daily limit and compact offers use canonical tariff values', () => {
  const now = new Date('2026-07-20T12:00:00.000Z');
  const paidUser = {
    downloads_today: 30,
    premium_limit: 30,
    premium_until: '2026-08-20T12:00:00.000Z'
  };
  const payload = buildLimitUpsell({ lang: 'ru', user: paidUser, freeLimit: 3, now });
  const offer = buildUpgradeOffer({ lang: 'en' });

  assert.match(payload.text, /Дневной лимит текущего тарифа исчерпан: 30/);
  assert.match(offer.text, /30 downloads daily[\s\S]*79 Stars/);
  assert.match(offer.text, /100 downloads daily[\s\S]*129 Stars/);
  assert.match(offer.text, /No download limits[\s\S]*199 Stars/);
  assert.doesNotMatch(offer.text, /support the project|Best value|power users/i);
  assert.doesNotMatch(offer.text, /₽|RUB/i);
});

test('invoice request guard blocks rapid duplicate taps and permits retry after failure or cooldown', () => {
  clearInvoiceRequestGuard();
  const startedAt = 1_000_000;

  assert.equal(acquireInvoiceRequest(123456789, 'plus', startedAt), true);
  assert.equal(acquireInvoiceRequest(123456789, 'plus', startedAt + 100), false);
  assert.equal(acquireInvoiceRequest(123456789, 'pro', startedAt + 100), true);
  assert.equal(acquireInvoiceRequest(123456789, 'plus', startedAt + INVOICE_REQUEST_COOLDOWN_MS), true);

  releaseInvoiceRequest(123456789, 'plus');
  assert.equal(acquireInvoiceRequest(123456789, 'plus', startedAt + 200), true);
  clearInvoiceRequestGuard();
});

test('tariff entry points use explicit pricing reasons and legacy payment callbacks stay intact', () => {
  const bot = fs.readFileSync(path.join(root, 'bot.js'), 'utf8');
  const limitUpsell = fs.readFileSync(path.join(root, 'services', 'limitUpsellService.js'), 'utf8');
  const paymentUi = `${bot}\n${limitUpsell}`;
  assert.match(bot, /open_tariffs_limit'[\s\S]{0,500}'limit_message'/);
  assert.match(bot, /bot\.command\('premium', \(ctx\) => upgradeHandler\(ctx, 'manual_command'\)\)/);
  assert.match(bot, /btn_upgrade'\), \(ctx\) => upgradeHandler\(ctx, 'menu_button'\)/);
  for (const callback of ['buy_plan_plus', 'buy_plan_pro', 'buy_plan_unlim', 'other_payment_methods']) {
    assert.match(paymentUi, new RegExp(callback));
  }
  assert.match(bot, /bot\.action\(\/\^buy_plan_[\s\S]{0,3500}replyWithInvoice/);
  assert.match(bot, /acquireInvoiceRequest\(userId, plan\)/);
  assert.match(bot, /releaseInvoiceRequest\(userId, plan\)/);
});

test('tariff debug block contains no database URL and remote fallback precedes final failure telemetry', () => {
  const bot = fs.readFileSync(path.join(root, 'bot.js'), 'utf8');
  const manager = fs.readFileSync(path.join(root, 'services', 'downloadManager.js'), 'utf8');
  const debugStart = bot.indexOf('[DEBUG] [Tariffs & Limits]');
  const debugEnd = bot.indexOf('});', debugStart);
  const debugBlock = bot.slice(debugStart, debugEnd);
  assert.doesNotMatch(debugBlock, /database_url|karaoke_database|DATABASE_URL/i);
  assert.match(debugBlock, /correlation_id/);

  const fallbackStart = manager.indexOf('if (isNetworkError && result.task)');
  const fallbackReturn = manager.indexOf('return;', fallbackStart);
  const finalFailure = manager.indexOf('trackDownloadFailureSafe(result.userId', fallbackStart);
  assert.ok(fallbackStart >= 0 && fallbackReturn > fallbackStart && finalFailure > fallbackReturn);
});
