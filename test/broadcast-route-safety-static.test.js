import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const formSource = await readFile(new URL('../views/broadcast-form.ejs', import.meta.url), 'utf8');
const workerSource = await readFile(new URL('../services/broadcastWorker.js', import.meta.url), 'utf8');
const dbSource = await readFile(new URL('../db.js', import.meta.url), 'utf8');

test('preview has a dedicated endpoint with no campaign or snapshot mutation', () => {
  const start = indexSource.indexOf("app.post('/broadcast/preview'");
  const end = indexSource.indexOf("app.get('/broadcast/:id/stats'", start);
  const previewRoute = indexSource.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(previewRoute, /sendBroadcastPreview\(/);
  assert.match(previewRoute, /adminId:\s*req\.session\.userId/);
  assert.match(previewRoute, /delete req\.session\.broadcastLaunchToken/);
  assert.doesNotMatch(previewRoute, /createBroadcastTask|updateBroadcastTask|createBroadcastSnapshot|startCampaignTransaction/);
});

test('preview buttons and JavaScript cannot submit the campaign form', () => {
  assert.match(formSource, /type="button" onclick="submitPreview\(event, 'ru'\)"/);
  assert.match(formSource, /type="button" onclick="submitPreview\(event, 'en'\)"/);
  assert.match(formSource, /async function submitPreview\(event, lang\)[\s\S]*?event\.preventDefault\(\);[\s\S]*?event\.stopPropagation\(\);/);
  assert.match(formSource, /fetch\('\/broadcast\/preview'/);
  assert.match(formSource, /formData\.delete\('launch_token'\)/);
  assert.doesNotMatch(formSource, /\.submit\(\)/);
});

test('launch route is fail-closed and requires a one-time token', () => {
  const start = indexSource.indexOf("app.post('/broadcast/launch'");
  const end = indexSource.indexOf("app.get('/texts'", start);
  const launchRoute = indexSource.slice(start, end);

  assert.match(launchRoute, /validateBroadcastLaunchRequest\(req\.session, \{ action, launch_token \}\)/);
  assert.match(launchRoute, /launch_confirmed_at:\s*new Date\(\)/);
  assert.match(launchRoute, /launch_confirmed_by:\s*req\.session\.userId/);
  assert.ok(launchRoute.indexOf('validateBroadcastLaunchRequest') < launchRoute.indexOf('createBroadcastTask'));
  assert.ok(launchRoute.indexOf('await areBroadcastsEnabled()') < launchRoute.indexOf('createBroadcastTask'));
});

test('worker and SQL require confirmation, cancellation state, and the kill switch', () => {
  assert.match(dbSource, /status = 'pending'[\s\S]*launch_confirmed_at IS NOT NULL[\s\S]*broadcasts_enabled/);
  assert.doesNotMatch(
    dbSource.match(/export async function getAndStartPendingBroadcastTask[\s\S]*?^}/m)?.[0] || '',
    /OR\s+\(status = 'processing'/
  );
  assert.match(workerSource, /await areBroadcastsEnabled\(\)/);
  assert.match(workerSource, /await getBroadcastExecutionState\(task\.id\)/);
  assert.match(workerSource, /executionState\.status === 'cancelled'/);
  assert.match(indexSource, /app\.post\('\/broadcast\/:id\/cancel'/);
  assert.match(dbSource, /UPDATE broadcast_log[\s\S]*SET status = 'cancelled'[\s\S]*status = 'pending'/);
});
