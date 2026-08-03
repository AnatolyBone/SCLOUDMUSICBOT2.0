import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../migrations/014_yandex_partner_campaigns.sql', import.meta.url), 'utf8');

test('Telegram send precedes the atomic impression operation', async () => {
  const source = await readFile(new URL('../services/downloadManager.js', import.meta.url), 'utf8');
  const handlerAt = source.indexOf('setTimeout(async () =>');
  const recordAt = source.indexOf('await db.recordPromoImpression', handlerAt);
  const sendAt = source.lastIndexOf('sendMessage', recordAt);
  assert.ok(handlerAt >= 0 && sendAt > handlerAt && recordAt > sendAt);
  assert.match(source.slice(handlerAt, recordAt), /yandex_promo_click:\$\{campaign\.promo_key\}/);
});

test('impression event and operational state update are one database operation', () => {
  const fn = migration.slice(migration.indexOf('record_ad_campaign_impression'), migration.indexOf('record_ad_campaign_click'));
  assert.match(fn, /INSERT INTO public\.analytics_events/);
  assert.match(fn, /UPDATE public\.ad_campaign_user_state/);
  assert.match(fn, /yandex_promo_shown/);
  for (const field of ['campaign_id','promo_key','message_id','placement','url_hash','trigger_download_count','impression_number']) assert.match(fn,new RegExp(`'${field}'`));
});

test('callback click is deduplicated per campaign, user and message before exposing URL', async () => {
  const source = await readFile(new URL('../bot.js', import.meta.url), 'utf8');
  const handlerAt = source.indexOf('bot.action(/^yandex_promo_click:');
  const recordAt = source.indexOf('await recordPromoClick', handlerAt);
  const guardAt = source.indexOf('if (!click)', recordAt);
  const urlButtonAt = source.indexOf('Markup.button.url', guardAt);
  assert.ok(handlerAt >= 0 && recordAt > handlerAt && guardAt > recordAt && urlButtonAt > guardAt);
  const fn = migration.slice(migration.indexOf('record_ad_campaign_click'), migration.indexOf('get_ad_campaign_stats'));
  assert.match(fn,/yandex_promo_clicked:%s:%s:%s/);
  assert.match(fn,/ON CONFLICT\(deduplication_key\)/);
  assert.match(fn,/clicks_count=clicks_count\+1/);
});

test('analytics stores hashes but never a raw promo URL', () => {
  for (const fnName of ['record_ad_campaign_impression','record_ad_campaign_click']) {
    const start = migration.indexOf(fnName);
    const block = migration.slice(start,start+3000);
    assert.match(block,/'url_hash'/);
    assert.doesNotMatch(block,/'url'/);
  }
});

test('campaign statistics RPC reads analytics events, not operational state', () => {
  const fn = migration.slice(migration.indexOf('get_ad_campaign_stats'),migration.indexOf('INSERT INTO public.ad_campaigns'));
  assert.match(fn,/FROM public\.analytics_events/);
  assert.doesNotMatch(fn,/ad_campaign_user_state/);
  for (const metric of ['impressions','unique_impressions','clicks','unique_clicks','ctr','repeat_impressions','average_impressions_per_user','last_shown_at','last_clicked_at']) assert.match(fn,new RegExp(metric));
});
