import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getActiveTariffCode, getEffectiveDownloadLimit } from '../services/downloadLimitCore.js';
import { buildUserTariffPresentation } from '../services/userTariffPresentation.js';

const limits={free:5,plus:30,pro:100,unlimited:10000};
const active='2099-01-01T00:00:00Z';

test('stale free code with legacy Plus renders Plus and 10/30',()=>{
 const user={premium_limit:30,premium_until:active,tariff_code:'free',daily_limit_override:null,downloads_today:10};
 assert.equal(getActiveTariffCode(user),'plus');
 assert.equal(getEffectiveDownloadLimit(user,limits),30);
 const view=buildUserTariffPresentation(user,limits);
 assert.equal(view.planName,'Plus'); assert.equal(`${user.downloads_today}/${view.effectiveLimit}`,'10/30');
});

test('stale free code classifies legacy Pro',()=>{
 const user={premium_limit:100,premium_until:active,tariff_code:'free',daily_limit_override:null};
 assert.equal(getActiveTariffCode(user),'pro'); assert.equal(getEffectiveDownloadLimit(user,limits),100);
});

test('stale free code classifies legacy Unlimited',()=>{
 const user={premium_limit:null,premium_until:active,tariff_code:'free',daily_limit_override:null};
 assert.equal(getActiveTariffCode(user),'unlimited'); assert.equal(getEffectiveDownloadLimit(user,limits),Infinity);
});

test('intentional override remains stronger than Plus',()=>{
 const user={premium_limit:30,premium_until:active,tariff_code:'plus',daily_limit_override:15};
 assert.equal(getEffectiveDownloadLimit(user,limits),15);
});

test('all subscription write paths synchronize tariff_code',async()=>{
 const db=await readFile(new URL('../db.js',import.meta.url),'utf8');
 const guard=await readFile(new URL('../migrations/016_tariff_code_consistency.sql',import.meta.url),'utf8');
 const dbRunner=await readFile(new URL('../db.js',import.meta.url),'utf8');
 assert.match(db,/tariff_code = CASE WHEN \$2 IS NULL THEN 'unlimited'/);
 assert.ok((db.match(/tariff_code = 'free'/g)||[]).length>=3);
 assert.match(guard,/BEFORE INSERT OR UPDATE OF premium_limit,premium_until/);
 assert.match(guard,/UPDATE public\.users SET tariff_code=CASE/);
 assert.doesNotMatch(guard,/ALTER FUNCTION public\.process_stars_payment/);
 assert.doesNotMatch(guard,/ALTER FUNCTION public\.process_manual_payment/);
 assert.doesNotMatch(guard,/CREATE OR REPLACE FUNCTION public\.process_stars_payment/);
 assert.doesNotMatch(guard,/CREATE OR REPLACE FUNCTION public\.process_manual_payment/);
 assert.doesNotMatch(guard,/process_stars_payment_legacy_016/);
 assert.doesNotMatch(guard,/process_manual_payment_legacy_016/);
 assert.doesNotMatch(guard,/daily_limit_override/);
 assert.match(dbRunner,/runPreflightFixesMigration[\s\S]*016_tariff_code_consistency\.sql/);
});

test('profile receives server-computed tariff presentation',async()=>{
 const route=await readFile(new URL('../index.js',import.meta.url),'utf8');
 const profile=await readFile(new URL('../views/user-profile.ejs',import.meta.url),'utf8');
 assert.match(route,/buildUserTariffPresentation\(userProfile, tariffLimits\)/);
 assert.match(profile,/tariffPresentation/);
 assert.doesNotMatch(profile,/activeTariff = premiumActive/);
});
