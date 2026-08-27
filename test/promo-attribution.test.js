import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ejs from 'ejs';
import { addPromoRates } from '../services/promoAnalyticsService.js';

const db = await readFile(new URL('../db.js', import.meta.url), 'utf8');
const view = await readFile(new URL('../views/promo-campaigns.ejs', import.meta.url), 'utf8');

test('one impression and one click produce 100% total and unique CTR', () => {
  const row = addPromoRates({ impressions: 1, unique_impressions: 1, clicks: 1, unique_clicks: 1 });
  assert.equal(row.ctr, 100);
  assert.equal(row.unique_ctr, 100);
  assert.equal(row.frequency, 1);
});

test('ten impressions and one click produce 10% total CTR', () => {
  const row = addPromoRates({ impressions: 10, unique_impressions: 10, clicks: 1, unique_clicks: 1 });
  assert.equal(row.ctr, 10);
  assert.equal(row.unique_ctr, 10);
});

test('repeat impressions keep total CTR, unique CTR and frequency separate', () => {
  const row = addPromoRates({ impressions: 3, unique_impressions: 1, clicks: 2, unique_clicks: 1 });
  assert.equal(row.ctr, 200 / 3);
  assert.equal(row.unique_ctr, 100);
  assert.equal(row.frequency, 3);
});

test('zero denominators never produce NaN or Infinity', () => {
  const row = addPromoRates({ clicks: 1, unique_clicks: 1 });
  assert.deepEqual([row.ctr, row.unique_ctr, row.frequency], [0, 0, 0]);
});

test('production control example has the expected three different rates', () => {
  const row = addPromoRates({ impressions: 1696, unique_impressions: 1275, clicks: 33, unique_clicks: 33 });
  assert.equal(row.frequency.toFixed(2), '1.33');
  assert.equal(row.ctr.toFixed(2), '1.95');
  assert.equal(row.unique_ctr.toFixed(2), '2.59');
});

test('new clicks are atomically enriched from the exact impression', () => {
  const fn = db.slice(db.indexOf('export async function recordPromoClick'), db.indexOf('export async function markCustomPromoShown'));
  for (const field of ['impression_id','creative_variant','has_media','media_type','trigger_type','trigger_download_count']) {
    assert.match(fn, new RegExp(`'${field}'`));
  }
  assert.match(fn, /yandex_promo_shown:\$\{campaignId\}:\$\{userId\}:\$\{messageId\}/);
  assert.match(fn, /yandex_promo_clicked:\$\{campaignId\}:\$\{userId\}:\$\{messageId\}/);
  assert.match(fn, /BEGIN[\s\S]+COMMIT[\s\S]+ROLLBACK/);
});

test('historical clicks are attributed only by campaign, user and Telegram message', () => {
  const cte = db.slice(db.indexOf('const PROMO_ATTRIBUTED_EVENTS_CTE'), db.indexOf('async function getPromoCampaignStatsForPeriod'));
  assert.match(cte, /candidate\.user_id=e\.user_id AND candidate\.campaign_id=e\.campaign_id/);
  assert.match(cte, /e\.message_id IS NOT NULL AND candidate\.message_id=e\.message_id/);
  assert.match(cte, /candidate\.created_at<=e\.created_at/);
  assert.match(cte, /COALESCE\(NULLIF\(e\.event_data->>'creative_variant'/);
});

test('creative and trigger reports expose all requested metrics and trigger value', () => {
  for (const label of ['Уник. показы','Уник. клики','CTR','Unique CTR','Frequency','Скачиваний при показе']) assert.ok(view.includes(label));
  assert.match(db, /GROUP BY has_media,creative_variant/);
  assert.match(db, /GROUP BY trigger_type,trigger_value/);
});

test('media/text and campaign separation are explicit in attributed analytics', () => {
  assert.match(db, /has_media,creative_variant/);
  assert.match(db, /WHERE candidate\.user_id=e\.user_id AND candidate\.campaign_id=e\.campaign_id/);
  assert.match(db, /FROM promo_per_user GROUP BY campaign_id/);
});

test('the same period bounds filter impressions and clicks', () => {
  assert.match(db, /promo_period_events AS \([\s\S]+e\.created_at>=b\.from_at[\s\S]+e\.created_at<b\.to_at/);
  assert.match(db, /FROM promo_period_events e WHERE e\.event_name='yandex_promo_shown'/);
  assert.match(db, /FROM promo_period_events e[\s\S]+WHERE e\.event_name='yandex_promo_clicked'/);
});

test('promo admin template renders safely without analytics rows', () => {
  const html = ejs.render(view, {
    contentFor: () => '', locals: {}, campaigns: [], stats: {}, creativeStats: [], triggerStats: []
  }, { filename: new URL('../views/promo-campaigns.ejs', import.meta.url).pathname });
  assert.equal(typeof html, 'string');
});

test('promo admin template renders attributed creative and trigger rows', () => {
  const metricRow = addPromoRates({ impressions: 1696, unique_impressions: 1275, clicks: 33, unique_clicks: 33 });
  const creativeStats = [{ ...metricRow, creative_variant: 'balance300:text', has_media: false }];
  const triggerStats = [{ ...metricRow, trigger_type: 'download_count', trigger_value: '3' }];
  const html = ejs.render(view, {
    contentFor: () => '', locals: { creativeStats, triggerStats }, campaigns: [], stats: {}, creativeStats, triggerStats
  }, { filename: new URL('../views/promo-campaigns.ejs', import.meta.url).pathname });
  for (const value of ['balance300:text','download_count','1.33','1.9%','2.6%']) assert.ok(html.includes(value));
});
