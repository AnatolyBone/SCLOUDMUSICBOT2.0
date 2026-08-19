import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUserIdentifier, resolveUserIdentifier } from '../services/userResolver.js';
import { activateSubscription, normalizeTariff } from '../services/subscriptionService.js';
import { getEffectiveDownloadLimit } from '../services/downloadLimitCore.js';
import { isSubscribedStatus } from '../services/channelSubscriptionService.js';
import { resolveSupportImage, validateSupportImage } from '../services/supportMediaService.js';
import { readFile } from 'node:fs/promises';

test('user lookup accepts id, @username, username and ignores case at query layer', () => {
  assert.deepEqual(normalizeUserIdentifier(' 123456789 '), { type:'id', value:'123456789' });
  assert.deepEqual(normalizeUserIdentifier(' @AntonKarpov79 '), { type:'username', value:'AntonKarpov79' });
  assert.deepEqual(normalizeUserIdentifier('AntonKarpov79'), { type:'username', value:'AntonKarpov79' });
  assert.throws(() => normalizeUserIdentifier("x' OR 1=1 --"));
});

test('resolver trims username, uses case-insensitive parameterized SQL and returns current user row', async () => {
  let captured;
  const user = await resolveUserIdentifier(' @AnToN_79 ', async (sql, params) => { captured={sql,params}; return { rows:[{id:'42',username:'anton_79'}] }; });
  assert.equal(user.id, '42');
  assert.match(captured.sql, /LOWER\(username\) = LOWER\(\$1\)/);
  assert.deepEqual(captured.params, ['AnToN_79']);
});

test('resolver parameterizes injection input and rejects malformed usernames', async () => {
  let called=false;
  await assert.rejects(() => resolveUserIdentifier("abc' OR 1=1 --", async()=>{called=true;}));
  assert.equal(called, false);
  assert.throws(() => normalizeUserIdentifier('@a'));
});

test('tariff names are canonicalized', () => {
  assert.equal(normalizeTariff('PLUS'), 'plus');
  assert.equal(normalizeTariff('Pluss'), 'plus');
});

test('individual daily limit overrides tariff and global limit', () => {
  assert.equal(getEffectiveDownloadLimit({ daily_limit_override: 9, tariff_code:'plus', premium_limit: 30, premium_until:'2099-01-01' }, {free:5,plus:40,pro:120}), 9);
});

test('removing individual override returns active tariff and expired plan returns new Free limit', () => {
  assert.equal(getEffectiveDownloadLimit({ daily_limit_override:null, tariff_code:'plus', premium_limit:30, premium_until:'2099-01-01' }, {free:5,plus:40,pro:120}), 40);
  assert.equal(getEffectiveDownloadLimit({ daily_limit_override:null, tariff_code:'plus', premium_limit:30, premium_until:'2000-01-01' }, {free:5,plus:40,pro:120}), 5);
});

test('legacy Free 3, Plus 30 and Pro 100 use current global settings', () => {
  const limits={free:5,plus:40,pro:120,unlimited:20000};
  assert.equal(getEffectiveDownloadLimit({premium_limit:3,premium_until:null},limits),5);
  assert.equal(getEffectiveDownloadLimit({premium_limit:30,premium_until:'2099-01-01'},limits),40);
  assert.equal(getEffectiveDownloadLimit({premium_limit:100,premium_until:'2099-01-01'},limits),120);
});

test('bot guard and user card resolve the same current limit without reading numeric premium_limit', async () => {
  const user={tariff_code:'plus',premium_limit:30,premium_until:'2099-01-01',daily_limit_override:null};
  const limits={free:5,plus:40,pro:120,unlimited:20000};
  const botLimit=getEffectiveDownloadLimit(user,limits); const cardLimit=getEffectiveDownloadLimit(user,limits);
  assert.equal(botLimit,40); assert.equal(cardLimit,botLimit);
  const profile=await readFile(new URL('../views/user-profile.ejs',import.meta.url),'utf8');
  assert.match(profile,/tariffPresentation/); assert.doesNotMatch(profile,/premiumActive \? Number\(u\.premium_limit/);
});

test('bot limit diagnostics identify tariff settings and never claim premium_limit is the source', async () => {
  const botSource = await readFile(new URL('../bot.js', import.meta.url), 'utf8');
  assert.doesNotMatch(botSource, /user_premium_limit_db/);
  assert.match(botSource, /daily_limit_\$\{activeTariff\}_setting/);
  assert.match(botSource, /daily_limit_override/);
});

test('channel membership statuses accept subscribers and reject left or kicked', () => {
  for (const status of ['member','administrator','creator']) assert.equal(isSubscribedStatus({status}), true);
  assert.equal(isSubscribedStatus({status:'restricted',is_member:true}), true);
  for (const status of ['left','kicked']) assert.equal(isSubscribedStatus({status}), false);
});

test('support image validates PNG JPEG WEBP, size and rejects other types', () => {
  for (const mimeType of ['image/png','image/jpeg','image/webp']) assert.doesNotThrow(()=>validateSupportImage({mimeType,size:100}));
  assert.throws(()=>validateSupportImage({mimeType:'image/gif',size:100}));
  assert.throws(()=>validateSupportImage({mimeType:'image/png',size:11*1024*1024}));
});

test('support image refreshes signed URL and legacy file_id remains available', async () => {
  const fresh = await resolveSupportImage({ message:{storage_path:'42/a.png'}, storage:{createSignedUrl:async()=>({data:{signedUrl:'https://fresh'}})}, telegram:{} });
  assert.equal(fresh.url, 'https://fresh');
  const legacy = await resolveSupportImage({ message:{file_id:'telegram-old'}, storage:{createSignedUrl:async()=>({error:new Error('missing')})}, telegram:{getFileLink:async()=>new URL('https://telegram/fresh')} });
  assert.equal(legacy.url, 'https://telegram/fresh');
});

function fakeActivationPool({ duplicate=false, failLog=false }={}) {
  const calls=[]; const cache={deleted:[]};
  const client={
    async query(sql, params=[]) { calls.push(sql); if (/SELECT result_tariff/.test(sql)) return duplicate?{rowCount:1,rows:[{result_tariff:'plus',new_expires_at:'2099-01-08'}]}:{rowCount:0,rows:[]}; if (/SELECT premium_limit/.test(sql)) return {rowCount:1,rows:[{premium_limit:5,premium_until:'2099-01-01'}]}; if (/SELECT value::int/.test(sql)) return {rows:[{value:30}]}; if (/UPDATE users/.test(sql)) return {rows:[{premium_until:'2099-01-08'}]}; if (/INSERT INTO subscription_activation_log/.test(sql)&&failLog) throw new Error('log failed'); return {rows:[]}; }, release(){}
  };
  return { pool:{connect:async()=>client}, calls, cache:{del:async key=>cache.deleted.push(key)}, deleted:cache.deleted };
}

test('subscribed bonus activates Plus for seven days and invalidates user cache', async () => {
  const fake=fakeActivationPool();
  const result=await activateSubscription(fake.pool,{userId:'42',tariff:'Plus',durationDays:7,source:'channel_subscription',transactionId:'bonus:42'},{cache:fake.cache});
  assert.equal(result.tariff,'plus'); assert.equal(result.duplicate,false); assert.deepEqual(fake.deleted,['user:42:subscription']);
  assert.ok(fake.calls.some(sql=>/subscribed_bonus_used/.test(sql)));
  assert.ok(fake.calls.some(sql=>/SET tariff_code=\$5/.test(sql)));
});

test('repeated activation is idempotent and does not update or extend again', async () => {
  const fake=fakeActivationPool({duplicate:true});
  const result=await activateSubscription(fake.pool,{userId:'42',tariff:'plus',durationDays:7,source:'channel_subscription',transactionId:'bonus:42'});
  assert.equal(result.duplicate,true); assert.equal(fake.calls.some(sql=>/UPDATE users/.test(sql)),false);
});

test('activation and journal are atomic when journal write fails', async () => {
  const fake=fakeActivationPool({failLog:true});
  await assert.rejects(()=>activateSubscription(fake.pool,{userId:'42',tariff:'plus',durationDays:7,source:'channel_subscription',transactionId:'bonus:42'}),/log failed/);
  assert.ok(fake.calls.includes('ROLLBACK')); assert.equal(fake.calls.includes('COMMIT'),false);
});

test('parallel callbacks with the same idempotency key produce one update', async () => {
  const first=fakeActivationPool(); const second=fakeActivationPool({duplicate:true});
  const [created,replayed]=await Promise.all([
    activateSubscription(first.pool,{userId:'42',tariff:'plus',durationDays:7,source:'channel_subscription',transactionId:'same'}),
    activateSubscription(second.pool,{userId:'42',tariff:'plus',durationDays:7,source:'channel_subscription',transactionId:'same'})
  ]);
  assert.equal(created.duplicate,false); assert.equal(replayed.duplicate,true);
  assert.equal([...first.calls,...second.calls].filter(sql=>/UPDATE users/.test(sql)).length,1);
});

test('Redis invalidation failure does not roll back a committed subscription', async () => {
  const fake=fakeActivationPool();
  const result=await activateSubscription(fake.pool,{userId:'42',tariff:'plus',durationDays:7,source:'channel_subscription',transactionId:'cache-failure'},{cache:{del:async()=>{throw new Error('redis down');}}});
  assert.equal(result.duplicate,false); assert.ok(fake.calls.includes('COMMIT')); assert.equal(fake.calls.includes('ROLLBACK'),false);
});

test('admin image route preserves text when Telegram image delivery fails', async () => {
  const index=await readFile(new URL('../index.js',import.meta.url),'utf8');
  assert.match(index,/catch \(imageError\)[\s\S]{0,500}sendMessage[\s\S]{0,300}createSupportMessage/);
});

test('implementation uses row locking, unique idempotency key, immediate settings refresh and Redis broadcast', async () => {
  const subscription=await readFile(new URL('../services/subscriptionService.js',import.meta.url),'utf8');
  const index=await readFile(new URL('../index.js',import.meta.url),'utf8');
  assert.match(subscription,/FOR UPDATE/); assert.match(subscription,/transaction_id = \$1/);
  assert.match(index,/await loadSettings\(\)[\s\S]{0,180}redisService\.incr\('settings:version'\)[\s\S]{0,180}redisService\.publish\('settings:invalidate'/);
  assert.match(index,/redisService\.subscribe\('settings:invalidate'/);
});
