import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const db=await readFile(new URL('../db.js',import.meta.url),'utf8');
const index=await readFile(new URL('../index.js',import.meta.url),'utf8');
const dashboard=await readFile(new URL('../views/dashboard.ejs',import.meta.url),'utf8');

test('Dashboard promo table is dynamic and contains no fixed campaign rows',()=>{
  assert.match(dashboard,/\(locals\.promoStats \|\| \[\]\)\.forEach/);
  assert.match(dashboard,/<%= c\.name %>/);assert.match(dashboard,/<%= c\.promo_key %>/);
  const block=dashboard.slice(dashboard.indexOf('Монетизация (промо)'),dashboard.indexOf('=== ГРАФИКИ'));
  assert.doesNotMatch(block,/Яндекс 300₽ — показов|Яндекс Музыка — показов|3\+ скачивания в акции/);
});

test('Dashboard campaigns and ad management use the same analytics stats RPC',()=>{
  const dashboardFn=db.slice(db.indexOf('export async function getDashboardPromoCampaignStats'),db.indexOf('export async function getCustomPromoProgressForUser'));
  const managementFn=db.slice(db.indexOf('export async function getPromoStats'),db.indexOf('export async function getPromoCreativeStats'));
  assert.match(dashboardFn,/get_ad_campaign_stats/);assert.match(managementFn,/get_ad_campaign_stats/);
  for(const metric of ['impressions','unique_impressions','clicks','unique_clicks','ctr'])assert.match(dashboard,new RegExp(`c\.${metric}`));
});

test('active zero-impression custom campaigns appear immediately and archived campaigns are optional',()=>{
  const fn=db.slice(db.indexOf('export async function getDashboardPromoCampaignStats'),db.indexOf('export async function getCustomPromoProgressForUser'));
  assert.match(fn,/c\.is_active=true OR COALESCE\(s\.impressions,0\)>0/);
  assert.match(fn,/\$1::boolean OR c\.is_archived=false/);
  assert.match(index,/showArchivedPromos/);
});

test('shown and clicked events drive counts and unique-viewer CTR',()=>{
  assert.match(db,/get_ad_campaign_stats/);
  assert.match(dashboard,/c\.unique_impressions \? c\.ctr\.toFixed\(1\)/);
  assert.doesNotMatch(dashboard,/yandex_promo_count|yandex_music_promo_count/);
});

test('legacy system counters are preserved separately without polluting period CTR',()=>{
  const fn=db.slice(db.indexOf('export async function getDashboardPromoCampaignStats'),db.indexOf('export async function getCustomPromoProgressForUser'));
  assert.match(fn,/yandex_promo_shown/);assert.match(fn,/yandex_music_promo_shown/);assert.match(fn,/legacy_impressions/);
  assert.match(dashboard,/исторических/);assert.match(dashboard,/не включаются в CTR/);
});

test('promo period defaults to 30 days and supports today, 7d, 30d and all',()=>{
  assert.match(index,/\['today','7d','30d','all'\]/);assert.match(index,/: '30d'/);
  for(const period of ['today','7d','30d','all'])assert.match(dashboard,new RegExp(`'${period}'`));
});
