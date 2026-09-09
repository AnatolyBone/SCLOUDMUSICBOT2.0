import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const index = await readFile(new URL('../index.js', import.meta.url), 'utf8');

test('production can skip startup migrations while retaining schema preflight', () => {
  const start = index.slice(index.indexOf('async function startApp()'), index.indexOf('// Историческая миграция лимитов'));
  assert.match(start, /SKIP_STARTUP_MIGRATIONS/);
  assert.match(start, /if \(skipStartupMigrations\)[\s\S]+else \{[\s\S]+runSupportSystemMigration/);
  assert.match(start, /runAnalyticsSystemMigration/);
  assert.match(start, /runMultilangSystemMigration/);
  assert.match(start, /runPreflightFixesMigration/);
  assert.match(start, /}\s+await checkSchemaPreflight/);
});
