import test from 'node:test';
import assert from 'node:assert/strict';
import { isCampaignEligible, normalizePromoKey, selectWeightedCampaign } from '../services/promoCampaignService.js';
import { readFile } from 'node:fs/promises';

const now = new Date('2026-08-02T12:00:00Z');
const base = {id:1,promo_key:'balance300',is_active:true,category:'yandex',weight:25,url:'https://example.com',message_text:'promo',trigger_downloads:3,cooldown_days:7,max_impressions_per_user:3};
const context = {downloadCount:3,byCampaign:{},globalYandexCooldownDays:7};

test('promo_key is normalized and constrained', () => {
  assert.equal(normalizePromoKey('New Campaign 42'), 'new_campaign_42');
  assert.throws(() => normalizePromoKey('Яндекс'));
  assert.throws(() => normalizePromoKey('a'.repeat(41)));
});

test('Supabase schema enforces campaign identity and user-state relationships', async () => {
  const sql = await readFile(new URL('../migrations/014_yandex_partner_campaigns.sql', import.meta.url), 'utf8');
  assert.match(sql,/CREATE UNIQUE INDEX IF NOT EXISTS ux_ad_campaigns_promo_key/);
  assert.match(sql,/PRIMARY KEY\(campaign_id,user_id\)/);
  assert.match(sql,/campaign_id integer NOT NULL REFERENCES public\.ad_campaigns\(id\)/);
  assert.match(sql,/user_id bigint NOT NULL REFERENCES public\.users\(id\)/);
  for (const index of ['event_name','user_id','created_at','campaign_id_json','promo_key_json']) assert.match(sql,new RegExp(`idx_analytics_events_${index}`));
});

test('inactive, zero-weight, early and expired campaigns are ineligible', () => {
  assert.equal(isCampaignEligible({...base,is_active:false},context,now), false);
  assert.equal(isCampaignEligible({...base,weight:0},context,now), false);
  assert.equal(isCampaignEligible({...base,starts_at:'2026-08-03T00:00:00Z'},context,now), false);
  assert.equal(isCampaignEligible({...base,ends_at:'2026-08-01T00:00:00Z'},context,now), false);
});

test('campaign and global cooldowns plus per-user maximum are enforced', () => {
  assert.equal(isCampaignEligible(base,{...context,byCampaign:{1:{impressions:1,lastShownAt:'2026-08-01T12:00:00Z'}}},now), false);
  assert.equal(isCampaignEligible(base,{...context,lastYandexShownAt:'2026-08-01T12:00:00Z'},now), false);
  assert.equal(isCampaignEligible(base,{...context,byCampaign:{1:{impressions:3,lastShownAt:'2026-07-01T00:00:00Z'}}},now), false);
});

test('weighted rotation selects exactly one eligible campaign', () => {
  const campaigns = [base,{...base,id:2,promo_key:'rewards_landing',weight:75}];
  assert.equal(selectWeightedCampaign(campaigns,context,{now,random:()=>0.10}).id,1);
  assert.equal(selectWeightedCampaign(campaigns,context,{now,random:()=>0.90}).id,2);
  assert.equal(selectWeightedCampaign(campaigns.map(c=>({...c,is_active:false})),context,{now,random:()=>0}),null);
});

test('zero-day campaign and global cooldowns can be explicitly disabled', () => {
  const recent = '2026-08-02T11:59:00Z';
  assert.equal(isCampaignEligible({...base,cooldown_days:0},{...context,globalYandexCooldownDays:0,lastYandexShownAt:recent,byCampaign:{1:{impressions:1,lastShownAt:recent}}},now),true);
});
