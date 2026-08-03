import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isCampaignEligible, selectWeightedCampaign } from '../services/promoCampaignService.js';
import { claimPromoSession, getPromoSessionId, releasePromoSession } from '../services/promoSessionService.js';

const base={id:10,promo_key:'plus',is_active:true,is_archived:false,deleted_at:null,category:'yandex',weight:1,url:'https://example.com',message_text:'x',trigger_type:'activity_cooldown',trigger_download_count:3,cooldown_days:7,max_impressions_per_user:3,created_at:'2026-08-01T00:00:00Z'};

test('activity campaign becomes eligible only after seven days and only when evaluated by activity',()=>{
  const context={activityType:'main_menu',downloadCount:0,byCampaign:{},byCategory:{}};
  assert.equal(isCampaignEligible(base,context,new Date('2026-08-07T23:59:59Z')),false);
  assert.equal(isCampaignEligible(base,context,new Date('2026-08-08T00:00:00Z')),true);
});

test('there is no scheduler: temporal promo is evaluated from completed activity hooks',async()=>{
  const manager=await readFile(new URL('../services/downloadManager.js',import.meta.url),'utf8');
  const bot=await readFile(new URL('../bot.js',import.meta.url),'utf8');
  const promoFlow=manager.slice(manager.indexOf('export async function checkAndSendPromos'),manager.indexOf('async function getUserUsage'));
  assert.doesNotMatch(promoFlow,/cron\.schedule|setInterval/);
  assert.match(manager,/checkAndSendPromos\(userId, updatedUser, 'download_success'\)/);
  assert.match(bot,/checkAndSendPromos\(ctx\.from\.id,user,'main_menu'\)/);
});

test('one session can claim only one promo and failed pre-send attempt can release it',async()=>{
  const user=987654321;const session=await getPromoSessionId(user);
  assert.equal(await claimPromoSession(user,session),true);
  assert.equal(await claimPromoSession(user,session),false);
  await releasePromoSession(user,session);
  assert.equal(await claimPromoSession(user,session),true);
  await releasePromoSession(user,session);
});

test('category and campaign next eligible timestamps block a second promo',()=>{
  const now=new Date('2026-08-20T00:00:00Z');
  const future='2026-08-21T00:00:00Z';
  assert.equal(isCampaignEligible(base,{activityType:'main_menu',byCampaign:{10:{nextEligibleAt:future}},byCategory:{}},now),false);
  assert.equal(isCampaignEligible(base,{activityType:'main_menu',byCampaign:{},byCategory:{yandex:{nextEligibleAt:future}}},now),false);
});

test('maximum impressions and inactive or archived states remain enforced',()=>{
  const context={activityType:'main_menu',byCampaign:{10:{impressions:3}},byCategory:{}};
  assert.equal(isCampaignEligible(base,context,new Date('2026-08-20')),false);
  assert.equal(selectWeightedCampaign([{...base,is_active:false}],context,{now:new Date('2026-08-20')}),null);
  assert.equal(selectWeightedCampaign([{...base,is_archived:true}],context,{now:new Date('2026-08-20')}),null);
});

test('click cooldown, category cooldown and temporal analytics are atomic SQL state',async()=>{
  const sql=await readFile(new URL('../migrations/014_yandex_partner_campaigns.sql',import.meta.url),'utf8');
  assert.match(sql,/CREATE TABLE IF NOT EXISTS public\.ad_user_category_state/);
  assert.match(sql,/next_eligible_at=GREATEST/);
  assert.match(sql,/cooldown_after_click_days/);
  for(const field of ['trigger_type','days_since_previous_impression','user_session_id'])assert.match(sql,new RegExp(`'${field}'`));
  assert.match(sql,/get_ad_campaign_trigger_stats/);
});

test('Telegram failure does not call the impression RPC or update last shown',async()=>{
  const manager=await readFile(new URL('../services/downloadManager.js',import.meta.url),'utf8');
  const send=manager.indexOf('await bot.telegram.sendMessage',manager.indexOf('export async function checkAndSendPromos'));
  const record=manager.indexOf('await db.recordPromoImpression',send);
  assert.ok(send>=0&&record>send);
  assert.doesNotMatch(manager.slice(0,record),/last_shown_at\s*=/);
});

test('manual trigger is explicitly unavailable in admin until a delivery API exists',async()=>{
  const index=await readFile(new URL('../index.js',import.meta.url),'utf8');
  const view=await readFile(new URL('../views/promo-campaigns.ejs',import.meta.url),'utf8');
  assert.match(index,/trigger_type === 'manual'.*Ручной запуск кампаний пока недоступен/s);
  assert.match(view,/option value="manual" disabled.*Ручной запуск — пока недоступен/);
});

test('Redis session fallback emits a one-time cross-instance degradation warning',async()=>{
  const source=await readFile(new URL('../services/promoSessionService.js',import.meta.url),'utf8');
  assert.match(source,/redisDegradationLogged/);
  assert.match(source,/Cross-instance one-promo-per-session protection is degraded/);
  assert.match(source,/console\.warn/);
});

test('migration 014 has precheck, verification, lossless compatibility rollback and rerun marker',async()=>{
  const migration=await readFile(new URL('../migrations/014_yandex_partner_campaigns.sql',import.meta.url),'utf8');
  const precheck=await readFile(new URL('../migrations/014_yandex_partner_campaigns_precheck.sql',import.meta.url),'utf8');
  const verify=await readFile(new URL('../migrations/014_yandex_partner_campaigns_verify.sql',import.meta.url),'utf8');
  const rollback=await readFile(new URL('../migrations/014_yandex_partner_campaigns_rollback.sql',import.meta.url),'utf8');
  assert.match(migration,/migration_014_yandex_partner_campaigns_applied/);
  assert.doesNotMatch(migration,/migration_014_context|CREATE TEMP TABLE/);
  assert.match(migration,/NOT EXISTS \(SELECT 1 FROM public\.app_settings WHERE key='migration_014_yandex_partner_campaigns_applied'\)/);
  assert.match(migration,/ALTER COLUMN trigger_download_count SET DEFAULT 3/);
  assert.match(migration,/trigger_downloads,trigger_type,trigger_download_count,global_category_cooldown_days/);
  assert.match(precheck,/Read-only precheck/);
  assert.match(verify,/state matches event history/);
  assert.match(rollback,/Deliberately retained for lossless rollback/);
  assert.doesNotMatch(rollback,/DELETE FROM public\.analytics_events|DROP TABLE.*ad_campaign_user_state/is);
});
