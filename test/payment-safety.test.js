import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const botSource = await readFile(new URL('../bot.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const migrationSource = await readFile(new URL('../migrations/006_analytics_system.sql', import.meta.url), 'utf8');
const readLocale = async name => JSON.parse(
  (await readFile(new URL(`../locales/${name}.json`, import.meta.url), 'utf8')).replace(/^\uFEFF/, '')
);
const ru = await readLocale('ru');
const en = await readLocale('en');

test('/paysupport is registered and localized for RU and EN', () => {
  assert.match(botSource, /bot\.command\('paysupport',\s*paySupportHandler\)/);
  for (const locale of [ru, en]) {
    assert.match(locale.pay_support_info, /Telegram Stars/i);
    assert.match(locale.pay_support_info, /charge ID/i);
    assert.ok(locale.pay_support_alt_button);
    assert.ok(locale.pay_support_admin_button);
  }
});

test('manual Stars payments are denied by HTTP and PostgreSQL RPC layers', () => {
  assert.match(indexSource, /normalizedCurrency === 'XTR'/);
  assert.match(indexSource, /normalizedPaymentMethod === 'telegram_stars'/);
  assert.match(migrationSource, /UPPER\(COALESCE\(BTRIM\(p_currency\), ''\)\) = 'XTR'/);
  assert.match(migrationSource, /LOWER\(COALESCE\(BTRIM\(p_payment_method\), ''\)\) = 'telegram_stars'/);
  assert.match(migrationSource, /manual_stars_forbidden/);
});
