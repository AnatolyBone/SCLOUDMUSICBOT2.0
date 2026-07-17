import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { interpolateTemplate } from '../services/templateInterpolation.js';
import {
  getDownloadQueuePriority,
  getEffectiveDownloadLimit,
  getRemainingDownloads,
  isDownloadLimitReachedForUser,
  isUserUnlimited
} from '../services/downloadLimitCore.js';
import { claimDownloadRequest, getDownloadCorrelationId } from '../services/downloadFlowService.js';

const botSource = await readFile(new URL('../bot.js', import.meta.url), 'utf8');
const managerSource = await readFile(new URL('../services/downloadManager.js', import.meta.url), 'utf8');
const spotifySource = await readFile(new URL('../services/spotifyManager.js', import.meta.url), 'utf8');
const youtubeSource = await readFile(new URL('../services/youtubeManager.js', import.meta.url), 'utf8');
const i18nSource = await readFile(new URL('../services/i18nService.js', import.meta.url), 'utf8');
const future = '2035-01-01T00:00:00.000Z';
const past = '2020-01-01T00:00:00.000Z';
const now = new Date('2030-01-01T00:00:00.000Z');

function user(downloadsToday, premiumLimit, premiumUntil) {
  return { downloads_today: downloadsToday, premium_limit: premiumLimit, premium_until: premiumUntil };
}

test('referral templates render zero and positive counts in RU and EN without raw placeholders', async () => {
  for (const lang of ['ru', 'en']) {
    const localeText = await readFile(new URL(`../locales/${lang}.json`, import.meta.url), 'utf8');
    const locale = JSON.parse(localeText.replace(/^\uFEFF/, ''));
    for (const count of [0, 17]) {
      const result = interpolateTemplate(locale.menu_referral_block, {
        referral_count: count,
        referral_link: 'https://t.me/SCloudMusicBot?start=ref_123'
      }, { key: 'menu_referral_block', lang });
      assert.match(result, new RegExp(String(count)));
      assert.match(result, /https:\/\/t\.me\/SCloudMusicBot\?start=ref_123/);
      assert.doesNotMatch(result, /\{\{?referral_(?:count|link)\}?\}/);
    }
  }
});

test('legacy bot_texts overrides with single braces remain compatible', () => {
  const result = interpolateTemplate('Друзей: {referral_count}; ссылка: {referral_link}', {
    referral_count: 0,
    referral_link: 'https://t.me/TestBot?start=ref_42'
  }, { key: 'menu_referral_block', lang: 'ru' });

  assert.equal(result, 'Друзей: 0; ссылка: https://t.me/TestBot?start=ref_42');
  assert.doesNotMatch(result, /\{\{?referral_(?:count|link)\}?\}/);
  assert.match(i18nSource, /dbTexts\[key\]/, 'production translation must prefer bot_texts overrides');
  assert.match(i18nSource, /interpolateTemplate\(text, variables/, 'DB and JSON texts must use the same interpolator');
});

test('missing template variables are removed instead of leaking curly placeholders', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    assert.equal(interpolateTemplate('A={{known}} B={missing}', { known: 0 }, { key: 'safe', lang: 'ru' }), 'A=0 B=');
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /missing/);
  assert.doesNotMatch(warnings[0], /A=|known=|https?:\/\//);
});

test('Free, Plus and Pro boundaries use the centralized limit contract', () => {
  assert.equal(isDownloadLimitReachedForUser(user(2, null, null), 3, now), false);
  assert.equal(isDownloadLimitReachedForUser(user(3, null, null), 3, now), true);
  assert.equal(isDownloadLimitReachedForUser(user(29, 30, future), 3, now), false);
  assert.equal(isDownloadLimitReachedForUser(user(30, 30, future), 3, now), true);
  assert.equal(isDownloadLimitReachedForUser(user(99, 100, future), 3, now), false);
  assert.equal(isDownloadLimitReachedForUser(user(100, 100, future), 3, now), true);
});

test('active Unlimited is never coerced to zero or the Free fallback', () => {
  for (const downloadsToday of [1, 1000, 100000]) {
    const unlimited = user(downloadsToday, null, future);
    assert.equal(isUserUnlimited(unlimited, now), true);
    assert.equal(getEffectiveDownloadLimit(unlimited, 3, now), Infinity);
    assert.equal(getRemainingDownloads(unlimited, 3, now), Infinity);
    assert.equal(isDownloadLimitReachedForUser(unlimited, 3, now), false);
    assert.equal(getDownloadQueuePriority(unlimited, 3, now), 10000);
  }
});

test('expired and incomplete Unlimited states immediately fall back to the current Free setting', () => {
  assert.equal(getEffectiveDownloadLimit(user(2, null, past), 3, now), 3);
  assert.equal(getEffectiveDownloadLimit(user(2, null, null), 3, now), 3);
  assert.equal(isDownloadLimitReachedForUser(user(3, null, past), 3, now), true);

  const before = user(3, null, null);
  const after = user(3, null, future);
  assert.equal(isDownloadLimitReachedForUser(before, 3, now), true);
  assert.equal(isDownloadLimitReachedForUser(after, 3, now), false, 'no Redis tariff cache is involved');
});

test('one Telegram update can claim the same normalized URL only once', () => {
  const ctx = { update: { update_id: 555 }, from: { id: 42 }, state: {} };
  assert.equal(getDownloadCorrelationId(ctx), 'tg-555-42');
  assert.equal(claimDownloadRequest(ctx, 'https://soundcloud.com/a/b?utm_source=test'), true);
  assert.equal(claimDownloadRequest(ctx, 'https://soundcloud.com/a/b'), false);
  assert.equal(claimDownloadRequest(ctx, 'https://youtube.com/watch?v=first'), true);
  assert.equal(claimDownloadRequest(ctx, 'https://youtube.com/watch?v=second'), true);
});

test('production flows use the centralized guard before queue creation and delivery', () => {
  assert.equal((botSource.match(/bot\.on\('text'/g) || []).length, 1);
  assert.match(botSource, /claimDownloadRequest\(ctx, url\)/);
  assert.match(botSource, /await handleSoundCloudUrl\(ctx, url\)/);
  assert.match(botSource, /await enqueue\(ctx, ctx\.from\.id, cleanUrl, \{ isSingleTrack: true, metadata: data, correlationId \}\)/);
  assert.match(managerSource, /isDownloadLimitReachedForUser\(user, getConfiguredFreeDownloadLimit\(\)\)/);
  assert.match(managerSource, /isDownloadLimitReachedForUser\(deliveryUsage, getConfiguredFreeDownloadLimit\(\)\)/);
  assert.match(botSource, /if \(!cachedTrack && resolvedUrl !== cleanUrl\)/);
  assert.match(managerSource, /new Set\(\[url, fullUrl, cacheKey\]\.filter\(Boolean\)\)/);
  assert.doesNotMatch(managerSource, /downloads_today\s*>=\s*\w+\.premium_limit/);
  assert.doesNotMatch(managerSource, /premium_limit\s*\|\|/);
  assert.doesNotMatch(spotifySource, /premium_limit\s*\|\|/);
  assert.doesNotMatch(youtubeSource, /premium_limit\s*\|\|/);
});

test('over-limit branch returns before the first Enqueue success log and queue add', () => {
  const guardIndex = managerSource.indexOf('if (!user || isDownloadLimitReachedForUser(user, getConfiguredFreeDownloadLimit()))');
  const earlyReturnIndex = managerSource.indexOf("return { queued: false, reason: user ? 'limit_reached' : 'user_not_found' }", guardIndex);
  const enqueueLogIndex = managerSource.indexOf('console.log(`[Enqueue] User', guardIndex);
  const queueAddIndex = managerSource.indexOf('downloadQueue.add(', guardIndex);
  assert.ok(guardIndex >= 0);
  assert.ok(earlyReturnIndex > guardIndex);
  assert.ok(enqueueLogIndex > earlyReturnIndex);
  assert.ok(queueAddIndex > earlyReturnIndex);
});
