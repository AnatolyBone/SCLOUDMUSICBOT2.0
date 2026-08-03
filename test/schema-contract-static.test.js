import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCANNED_PATHS = ['db.js', 'index.js', 'bot.js', 'routes', 'services', 'scripts', 'views'];
const TEXT_EXTENSIONS = new Set(['.js', '.ejs']);

function sourceFiles(target) {
  const absolute = path.join(ROOT, target);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [absolute];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
    const child = path.join(absolute, entry.name);
    if (entry.isDirectory()) return sourceFiles(path.relative(ROOT, child));
    return TEXT_EXTENSIONS.has(path.extname(entry.name)) ? [child] : [];
  });
}

const runtimeSources = SCANNED_PATHS
  .flatMap(sourceFiles)
  .map(file => ({ file: path.relative(ROOT, file), text: fs.readFileSync(file, 'utf8') }));

function assertNoMatch(pattern, description) {
  const matches = runtimeSources
    .filter(({ text }) => pattern.test(text))
    .map(({ file }) => file);
  assert.deepEqual(matches, [], `${description}: ${matches.join(', ')}`);
}

function assertNoSqlTemplateMatch(pattern, description) {
  const matches = runtimeSources.filter(({ text }) => [...text.matchAll(/`([^`]*)`/g)].some(match => pattern.test(match[1]))).map(({ file }) => file);
  assert.deepEqual(matches, [], `${description}: ${matches.join(', ')}`);
}

test('runtime SQL does not use retired production column names', () => {
  assertNoSqlTemplateMatch(
    /(?:INSERT\s+INTO\s+(?:public\.)?broadcast_clicks\s*\([^)]*\bbroadcast_id\b|FROM\s+(?:public\.)?broadcast_clicks(?:\s+\w+)?\s+WHERE[^)]*\bbroadcast_id\b|JOIN\s+(?:public\.)?broadcast_clicks\s+\w+\s+ON[^\n]*\.broadcast_id\b)/i,
    'broadcast_clicks must use campaign_id'
  );
  assertNoMatch(
    /(?:FROM|JOIN)\s+(?:public\.)?broadcast_log[\s\S]{0,240}\bupdated_at\b/i,
    'broadcast_log must use sent_at'
  );
  assertNoMatch(
    /(?:FROM|JOIN|INTO)\s+(?:public\.)?language_history[\s\S]{0,240}\bchanged_at\b/i,
    'language_history must use created_at'
  );
});

test('Free tier is not hardcoded to five in runtime filters', () => {
  assertNoMatch(
    /premium_limit\s*(?:<=|>=|=|>|<|<>|!=)\s*5\b/i,
    'Free tier comparisons must use app_settings'
  );
  assertNoMatch(
    /daily_limit_free[^\n]{0,120}(?:\|\|\s*['"]5['"]|COALESCE[^\n]*,\s*5\))/i,
    'daily_limit_free fallback must be 3'
  );
});

test('schema preflight requires user insights migration version 12', () => {
  const dbSource = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
  const migration010 = fs.readFileSync(
    path.join(ROOT, 'migrations', '010_broadcast_launch_safety.sql'),
    'utf8'
  );
  const migration011 = fs.readFileSync(
    path.join(ROOT, 'migrations', '011_user_activity_bigint.sql'),
    'utf8'
  );
  const migration012 = fs.readFileSync(
    path.join(ROOT, 'migrations', '012_user_insights_indexes.sql'), 'utf8'
  );

  assert.match(dbSource, /REQUIRED_SCHEMA_VERSION = 12/);
  assert.match(dbSource, /RECOMMENDED_SCHEMA_INDEXES/);
  assert.match(dbSource, /missingRecommendedIndexes/);
  assert.match(dbSource, /actualSchemaVersion === REQUIRED_SCHEMA_VERSION/);
  assert.match(dbSource, /'user_activity\.user_id': 'int8'/);
  assert.match(dbSource, /typeMismatches/);

  assert.match(migration010, /launch_confirmed_at TIMESTAMP WITH TIME ZONE/);
  assert.match(migration010, /launch_confirmed_by BIGINT/);
  assert.match(migration010, /ck_broadcast_tasks_pending_confirmed/);
  assert.match(migration010, /VALUES \('broadcasts_enabled', 'false'\)/);
  assert.match(migration010, /v_schema_version[\s\S]*< 10/);

  assert.match(migration011, /pg_get_constraintdef\(c\.oid, true\)/);
  assert.match(migration011, /DROP CONSTRAINT user_activity_user_id_fkey/);
  assert.match(migration011, /ALTER COLUMN user_id TYPE BIGINT[\s\S]*USING user_id::BIGINT/);
  assert.match(migration011, /ADD CONSTRAINT %I %s/);
  assert.match(migration011, /VALUES \('schema_version', '11'\)/);
  assert.doesNotMatch(migration011, /ALTER\s+COLUMN\s+id\b/i);
  assert.doesNotMatch(migration011, /UPDATE\s+(?:public\.)?users/i);

  assert.match(migration012, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/g);
  assert.match(migration012, /idx_analytics_user_daily_user_day/);
  assert.match(migration012, /idx_users_created_at_id/);
  assert.doesNotMatch(migration012, /\b(?:INSERT|UPDATE|ALTER|DROP|DELETE)\b/i);
  assert.doesNotMatch(migration012, /\bBEGIN\b|\bCOMMIT\b/);
});

test('smoke runner keeps the complete administrative contract', () => {
  const smokeSource = fs.readFileSync(path.join(ROOT, 'services', 'analyticsSmokeTest.js'), 'utf8');
  const requiredTests = [
    'schema_preflight', 'analytics_dashboard', 'period_comparison', 'cohort_analysis',
    'user_timeline', 'retention_explorer', 'acquisition_sources',
    'revenue_dashboard', 'growth_assistant', 'excel_data_query', 'excel_generation',
    'broadcast_list', 'broadcast_stats', 'broadcast_audience_estimate',
    'user_language_profile', 'language_history', 'redirect_click_query',
    'payments_query', 'settings_query'
  ];
  for (const name of requiredTests) {
    assert.match(smokeSource, new RegExp(`['"]${name}['"]`), `missing smoke test ${name}`);
  }
});
