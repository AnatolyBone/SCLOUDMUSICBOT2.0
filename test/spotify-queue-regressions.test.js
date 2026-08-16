import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { TaskQueue } from '../lib/TaskQueue.js';
import { buildSpotifyCacheKey, getSpotifyQualityForUser, hasSpotifyUnlimitedAccess, isSpotifyCacheRowMatch } from '../services/spotifyPolicy.js';
import { scoreSpotifyYouTubeCandidate, selectSpotifyYouTubeCandidate } from '../services/spotifyMatcher.js';

const future = '2099-01-01T00:00:00.000Z';

test('Spotify track IDs and qualities have distinct cache identities', () => {
  assert.equal(buildSpotifyCacheKey('trackA', 'low'), 'spotify:trackA:low');
  assert.notEqual(buildSpotifyCacheKey('trackA', 'low'), buildSpotifyCacheKey('trackB', 'low'));
  assert.notEqual(buildSpotifyCacheKey('trackA', 'low'), buildSpotifyCacheKey('trackA', 'high'));
  assert.equal(buildSpotifyCacheKey(null, 'low'), null);
  const cachedB = { source: 'spotify', spotify_id: 'trackB', quality: 'low', file_id: 'file-B' };
  assert.equal(isSpotifyCacheRowMatch(cachedB, 'trackA', 'low'), false);
  assert.equal(isSpotifyCacheRowMatch(cachedB, 'trackB', 'high'), false);
  assert.equal(isSpotifyCacheRowMatch(cachedB, 'trackB', 'low'), true);
});

test('Free, Plus and Pro are forced to 128 kbps while Unlimited can choose', () => {
  const plans = [
    {},
    { tariff_code: 'plus', premium_until: future, premium_limit: 30 },
    { tariff_code: 'pro', premium_until: future, premium_limit: 100 }
  ];
  for (const user of plans) {
    assert.equal(getSpotifyQualityForUser(user, 'high', 2, 1), 'low');
    assert.equal(hasSpotifyUnlimitedAccess(user, 2, 1), false);
  }
  const unlimited = { tariff_code: 'unlimited', premium_until: future, premium_limit: null };
  assert.equal(getSpotifyQualityForUser(unlimited, 'high', 2, 1), 'high');
  assert.equal(hasSpotifyUnlimitedAccess(unlimited, 2, 1), true);
  assert.equal(getSpotifyQualityForUser({}, 'high', 1, 1), 'high');
});

test('Spotify YouTube matching rejects wrong title, artist and duration', () => {
  const track = { title: 'Ветром стать', artist: 'лампабикт', duration: 205 };
  const wrong = { title: 'На скейте', uploader: 'Лора', duration: 205, url: 'wrong' };
  const long = { title: 'лампабикт - Ветром стать', uploader: 'лампабикт', duration: 280, url: 'long' };
  const right = { title: 'лампабикт — Ветром стать (Official Audio)', uploader: 'лампабикт', duration: 207, url: 'right' };
  assert.equal(scoreSpotifyYouTubeCandidate(track, wrong), -Infinity);
  assert.equal(scoreSpotifyYouTubeCandidate(track, long), -Infinity);
  assert.equal(selectSpotifyYouTubeCandidate(track, [wrong, long, right]), right);
});

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('queue enforces 1 Spotify + 2 SoundCloud and skips a blocked Spotify head', async () => {
  const gates = new Map();
  const started = [];
  const queue = new TaskQueue({
    maxConcurrent: 3,
    sourceLimits: { spotify: 1, soundcloud: 2, youtube: 0 },
    taskProcessor: async task => {
      started.push(task.id);
      const gate = deferred();
      gates.set(task.id, gate);
      await gate.promise;
    }
  });

  const tasks = [
    queue.add({ id: 'sp1', source: 'spotify', url: 'sp1' }),
    queue.add({ id: 'sp2', source: 'spotify', url: 'sp2' }),
    queue.add({ id: 'sc1', source: 'soundcloud', url: 'sc1' }),
    queue.add({ id: 'sc2', source: 'soundcloud', url: 'sc2' })
  ];
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started.sort(), ['sc1', 'sc2', 'sp1']);
  assert.equal(queue.getStatsBySource().spotify.waiting, 1);
  for (const id of ['sp1', 'sc1', 'sc2']) gates.get(id).resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(started.includes('sp2'));
  gates.get('sp2').resolve();
  await Promise.all(tasks);
});

test('dynamic queue limits affect only subsequent starts', async () => {
  const gates = new Map();
  const started = [];
  const queue = new TaskQueue({
    maxConcurrent: 2,
    sourceLimits: { spotify: 2 },
    taskProcessor: async task => {
      started.push(task.id);
      const gate = deferred();
      gates.set(task.id, gate);
      await gate.promise;
    }
  });
  const p1 = queue.add({ id: 'one', source: 'spotify', url: 'one' });
  const p2 = queue.add({ id: 'two', source: 'spotify', url: 'two' });
  await new Promise(resolve => setImmediate(resolve));
  queue.setSourceLimits({ spotify: 1 });
  const p3 = queue.add({ id: 'three', source: 'spotify', url: 'three' });
  assert.deepEqual(started.sort(), ['one', 'two']);
  gates.get('one').resolve();
  gates.get('two').resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(started.includes('three'));
  gates.get('three').resolve();
  await Promise.all([p1, p2, p3]);
});

test('migration 015 is idempotent and connected to the production migration runner', async () => {
  const [dbSource, migration] = await Promise.all([
    readFile(new URL('../db.js', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/015_download_worker_settings.sql', import.meta.url), 'utf8')
  ]);
  assert.match(dbSource, /runPreflightFixesMigration[\s\S]*015_download_worker_settings\.sql/);
  assert.match(migration, /ON CONFLICT \(key\) DO NOTHING/);
  for (const key of ['download_workers_total', 'download_workers_spotify', 'download_workers_soundcloud', 'download_workers_youtube']) {
    assert.match(migration, new RegExp(`'${key}'`));
  }
});
