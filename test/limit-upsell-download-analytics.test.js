import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildLimitUpsell } from '../services/limitUpsellService.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('limit upsell keeps the subscription bonus and always exposes the tariff action in RU and EN', () => {
  const ru = buildLimitUpsell({ lang: 'ru', channelUsername: '@SCM_BLOG', bonusAvailable: true });
  const en = buildLimitUpsell({ lang: 'en', channelUsername: '@SCM_BLOG', bonusAvailable: true });

  for (const payload of [ru, en]) {
    const callbacks = payload.extra.reply_markup.inline_keyboard.flat().map(button => button.callback_data);
    assert.deepEqual(callbacks, ['check_subscription', 'open_tariffs_limit']);
    assert.match(payload.text, /SCM_BLOG/);
  }
  assert.match(ru.text, /Завтра доступные загрузки восстановятся автоматически/);
  assert.match(en.text, /reset automatically tomorrow/);
});

test('tariff entry points use explicit pricing reasons and legacy payment callbacks stay intact', () => {
  const bot = fs.readFileSync(path.join(root, 'bot.js'), 'utf8');
  assert.match(bot, /open_tariffs_limit'[\s\S]{0,500}'limit_message'/);
  assert.match(bot, /bot\.command\('premium', \(ctx\) => upgradeHandler\(ctx, 'manual_command'\)\)/);
  assert.match(bot, /btn_upgrade'\), \(ctx\) => upgradeHandler\(ctx, 'menu_button'\)/);
  for (const callback of ['buy_plan_plus', 'buy_plan_pro', 'buy_plan_unlim', 'other_payment_methods']) {
    assert.match(bot, new RegExp(callback));
  }
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
