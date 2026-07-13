import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const serviceSource = await readFile(new URL('../services/systemSelfTest.js', import.meta.url), 'utf8');
const analyticsView = await readFile(new URL('../views/analytics.ejs', import.meta.url), 'utf8');

test('admin self-test endpoint is authenticated and exposes all core checks', () => {
  assert.match(indexSource, /app\.post\('\/admin\/system\/self-test', requireAuth/);
  for (const check of ['database', 'analytics', 'broadcasts', 'workers', 'excel']) {
    assert.match(serviceSource, new RegExp(`${check}: 'error'`));
  }
  assert.match(analyticsView, /onclick="runSystemSelfTest\(\)"/);
});

test('broadcast self-test rolls all temporary database writes back', () => {
  assert.match(serviceSource, /await client\.query\('BEGIN'\)/);
  assert.match(serviceSource, /await client\.query\('ROLLBACK'\)/);
  assert.doesNotMatch(serviceSource, /telegram\.sendMessage|runBroadcastBatch/);
});
