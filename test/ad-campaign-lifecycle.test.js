import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isCampaignEligible } from '../services/promoCampaignService.js';

const db=await readFile(new URL('../db.js',import.meta.url),'utf8');
const index=await readFile(new URL('../index.js',import.meta.url),'utf8');
const view=await readFile(new URL('../views/promo-campaigns.ejs',import.meta.url),'utf8');
const migration=await readFile(new URL('../migrations/014_yandex_partner_campaigns.sql',import.meta.url),'utf8');

test('custom campaigns can be archived and restored without deleting analytics or user state',()=>{
  const archive=db.slice(db.indexOf('export async function archivePromoCampaign'),db.indexOf('export async function softDeletePromoCampaign'));
  assert.match(archive,/is_archived=true/);assert.match(archive,/campaign_archived/);assert.match(archive,/is_archived=false/);assert.match(archive,/campaign_restored/);
  assert.doesNotMatch(archive,/DELETE FROM (?:analytics_events|ad_campaign_user_state)/);
});

test('archived and deleted campaigns are never eligible for delivery',()=>{
  const base={id:1,is_active:true,is_archived:false,deleted_at:null,weight:1,url:'https://example.com',message_text:'x',trigger_downloads:1,max_impressions_per_user:3,cooldown_days:0};
  const context={downloadCount:1,byCampaign:{},globalYandexCooldownDays:0};
  assert.equal(isCampaignEligible({...base,is_archived:true},context),false);
  assert.equal(isCampaignEligible({...base,deleted_at:new Date()},context),false);
  assert.match(db,/deleted_at IS NULL.*AND is_active=true AND is_archived=false/);
});

test('system campaigns cannot be archived or deleted but can be disabled',()=>{
  assert.match(db,/Системную кампанию удалить нельзя\. Её можно отключить\./);
  assert.match(db,/Системную кампанию архивировать нельзя\. Её можно отключить\./);
  assert.match(index,/action:active\?'campaign_enabled':'campaign_disabled'/);
});

test('permanent deletion is authenticated, archive-only and requires exact campaign name',()=>{
  assert.match(index,/app\.delete\('\/admin\/api\/ad-campaigns\/:id',requireAuth/);
  assert.match(index,/if\(!campaign\.is_archived\)/);
  assert.match(index,/confirm_name/);
  assert.match(view,/Введите точное название кампании/);
});

test('soft deletion preserves history and operational state',()=>{
  const fn=db.slice(db.indexOf('export async function softDeletePromoCampaign'),db.indexOf('export async function resetSystemPromoCampaign'));
  assert.match(fn,/deleted_at=NOW\(\)/);
  assert.doesNotMatch(fn,/DELETE FROM/);
  assert.doesNotMatch(fn,/analytics_events|ad_campaign_user_state/);
  assert.match(migration,/campaign_name_snapshot/);
});

test('media is removed only when unshared and storage failure precedes database deletion',()=>{
  const route=index.slice(index.indexOf("app.delete('/admin/api/ad-campaigns/:id'"),index.indexOf("app.post('/promos/delete'"));
  assert.match(route,/!await isPromoMediaPathInUse/);
  assert.ok(route.indexOf('bucket.remove')<route.indexOf('softDeletePromoCampaign'));
  assert.match(route,/upload\(removedMedia\.path,removedMedia\.buffer/);
});

test('lifecycle and mutation actions are written to campaign audit log',()=>{
  for(const action of ['campaign_created','campaign_updated','campaign_enabled','campaign_disabled','campaign_archived','campaign_restored','campaign_deleted','campaign_media_replaced'])assert.match(db+index,new RegExp(action));
  assert.match(migration,/CREATE TABLE IF NOT EXISTS public\.ad_campaign_audit_log/);
  for(const field of ['campaign_id','promo_key','admin_id','old_values','new_values','created_at'])assert.match(migration,new RegExp(field));
});

test('admin UI exposes active, disabled, archived and all filters',()=>{
  for(const filter of ['active','disabled','archived','all'])assert.match(view,new RegExp(`data-filter="${filter}"`));
  for(const action of ['archive','restore','reset'])assert.match(view,new RegExp(`data-action="${action}"`));
});
