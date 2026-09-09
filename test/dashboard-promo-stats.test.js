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

test('Dashboard campaigns and ad management use the same attributed event query',()=>{
  const dashboardFn=db.slice(db.indexOf('export async function getDashboardPromoCampaignStats'),db.indexOf('export async function getCustomPromoProgressForUser'));
  const managementFn=db.slice(db.indexOf('export async function getPromoStats'),db.indexOf('export async function getPromoCreativeStats'));
  assert.match(dashboardFn,/getPromoCampaignStatsForPeriod/);assert.match(managementFn,/getPromoCampaignStatsForPeriod/);
  for(const metric of ['impressions','unique_impressions','clicks','unique_clicks','ctr','unique_ctr','frequency'])assert.match(dashboard,new RegExp(`c\.${metric}`));
});

test('active zero-impression custom campaigns appear immediately and archived campaigns are optional',()=>{
  const fn=db.slice(db.indexOf('export async function getDashboardPromoCampaignStats'),db.indexOf('export async function getCustomPromoProgressForUser'));
  assert.match(fn,/row\.is_active \|\| row\.impressions > 0 \|\| row\.clicks_total > 0 \|\| row\.legacy_impressions > 0/);
  assert.match(fn,/\$1::boolean OR c\.is_archived=false/);
  assert.match(index,/showArchivedPromos/);
});

test('shown and clicked events drive separate total CTR, unique CTR and frequency',()=>{
  assert.match(db,/promo_attributed_events/);
  assert.match(dashboard,/c\.impressions \? c\.ctr\.toFixed\(1\)/);
  assert.match(dashboard,/c\.unique_impressions \? c\.unique_ctr\.toFixed\(1\)/);
  assert.match(dashboard,/c\.unique_impressions \? c\.frequency\.toFixed\(2\)/);
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
