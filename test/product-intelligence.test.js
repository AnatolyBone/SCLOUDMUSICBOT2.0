import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifyDownloadFailure, PRICING_OPEN_REASONS } from '../services/analyticsService.js';
import { __productIntelligenceSql, getProductIntelligenceAnalytics } from '../services/productIntelligenceService.js';

test('download failures map to the stable Product Intelligence taxonomy', () => {
  assert.equal(classifyDownloadFailure(new Error('DRM_PROTECTED')), 'drm');
  assert.equal(classifyDownloadFailure(new Error('HTTP 413')), 'file_too_large');
  assert.equal(classifyDownloadFailure(new Error('404 Video unavailable')), '404');
  assert.equal(classifyDownloadFailure(new Error('TASK_TIMEOUT')), 'timeout');
  assert.equal(classifyDownloadFailure(new Error('Redis queue failed')), 'queue_failure');
  assert.equal(classifyDownloadFailure(new Error('unsupported format')), 'unsupported');
  assert.equal(classifyDownloadFailure(new Error('unexpected')), 'download_failed');
  assert.deepEqual(PRICING_OPEN_REASONS, [
    'daily_limit', 'manual_menu', 'premium_feature', 'playlist_limit',
    'referral_bonus_end', 'notification', 'other'
  ]);
});

test('Product Intelligence normalizes pricing, activity, retention and source economics', async () => {
  const fixtures = [
    [{ reason:'manual_menu', users:'5', events:'8' }],
    [{ users:5, first_download_users:5, limit_users:3, plan_users:4, invoice_users:3, payment_users:1,
       registration_to_download_seconds:'7200', download_to_limit_seconds:'86400', limit_to_menu_seconds:'120',
       menu_to_plan_seconds:'15', plan_to_invoice_seconds:'8', invoice_to_payment_seconds:'55' }],
    [{ segment:'0–5', users:5, payers:1, avg_downloads:'3.2' }],
    [{ group_name:'buyers', users:1, avg_account_age_days:'10', avg_downloads:'7', reached_limit_users:1, returned_users:1, avg_activity_events:'12' }],
    [{ day_number:7, eligible:10, returned:3 }],
    [{ source:'organic', users:10, payers:2, revenue_rub:'500' }],
    [{ reason:'menu_without_plan', users:4 }],
    [{ reason:'timeout', source:'youtube', events:3, users:2, opened_menu_users:1, payer_users:0 }]
  ];
  let call = 0;
  const result = await getProductIntelligenceAnalytics(
    { startAt:'2026-07-01T00:00:00+03:00', endAt:'2026-07-17T23:59:59+03:00', windowSeconds:86400 },
    ['1'],
    async (sql, params) => {
      assert.match(sql, /\$1/);
      assert.ok(Array.isArray(params));
      return { rows: fixtures[call++] };
    }
  );
  assert.equal(result.pricingOpenReasons[0].reason, 'manual_menu');
  assert.equal(result.journeyTimings.stages[0].averageSeconds, 7200);
  assert.equal(result.activityConversion[0].conversion, 20);
  assert.equal(result.paidRetention[0].rate, 30);
  assert.equal(result.sourceEconomics[0].arpu, 50);
  assert.equal(result.sourceEconomics[0].arppu, 250);
  assert.equal(result.downloadFailures[0].openedMenuUsers, 1);
});

test('Product Intelligence SQL stays read-only, bounded and parameterized', () => {
  for (const sql of Object.values(__productIntelligenceSql)) {
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
    assert.match(sql, /\$1/);
    assert.match(sql, /\$2/);
    assert.match(sql, /\$4/);
  }
  assert.match(__productIntelligenceSql.PAID_RETENTION_SQL, /VALUES \(1\), \(7\), \(30\), \(90\)/);
  assert.match(__productIntelligenceSql.SOURCE_ECONOMICS_SQL, /payment_status = 'completed'/);
  assert.match(__productIntelligenceSql.SOURCE_ECONOMICS_SQL, /xtr_rub_rate/);
});

test('runtime records pricing reasons and classified download failures without raw errors', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bot = fs.readFileSync(path.join(root, 'bot.js'), 'utf8');
  const analytics = fs.readFileSync(path.join(root, 'services', 'analyticsService.js'), 'utf8');
  const downloadManager = fs.readFileSync(path.join(root, 'services', 'downloadManager.js'), 'utf8');
  const insights = fs.readFileSync(path.join(root, 'services', 'userInsightsService.js'), 'utf8');
  const journey = fs.readFileSync(path.join(root, 'views', 'user-journey.ejs'), 'utf8');
  assert.match(bot, /pricing_open_reason: pricingOpenReason/);
  assert.match(bot, /playlist_limit_reached/);
  assert.match(analytics, /track_download_failed/);
  assert.match(downloadManager, /trackDownloadFailureSafe/);
  assert.doesNotMatch(analytics, /error_message:/);
  assert.match(insights, /'pricing_open_reason', e\.event_data->>'pricing_open_reason'/);
  assert.match(insights, /'failure_reason', e\.event_data->>'failure_reason'/);
  assert.match(insights, /'playlist_limit', e\.event_data->>'playlist_limit'/);
  assert.match(journey, /track_download_failed:'Скачивание завершилось классифицированной ошибкой\.'/);
  assert.match(journey, /Пользователь открыл тарифы\. Причина:/);
});

test('payment-loss UI uses unified cards, missing badges and a bounded event contract', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const view = fs.readFileSync(path.join(root, 'views', 'analytics.ejs'), 'utf8');
  assert.match(view, /payment-loss-card/);
  assert.match(view, /payment-loss-na/);
  assert.match(view, /payment-loss-contract-scroll/);
  assert.match(view, /sort\(\(a, b\) => b\.events - a\.events/);
  assert.match(view, /payment-loss-growth-empty/);
});
