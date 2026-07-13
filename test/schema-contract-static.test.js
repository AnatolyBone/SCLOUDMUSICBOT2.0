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

test('runtime SQL does not use retired production column names', () => {
  assertNoMatch(
    /(?:INSERT\s+INTO|FROM|JOIN)\s+(?:public\.)?broadcast_clicks[\s\S]{0,240}\bbroadcast_id\b/i,
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

test('smoke runner keeps the complete administrative contract', () => {
  const smokeSource = fs.readFileSync(path.join(ROOT, 'services', 'analyticsSmokeTest.js'), 'utf8');
  const requiredTests = [
    'schema_preflight', 'analytics_dashboard', 'period_comparison', 'cohort_analysis',
    'revenue_dashboard', 'growth_assistant', 'excel_data_query', 'excel_generation',
    'broadcast_list', 'broadcast_stats', 'broadcast_audience_estimate',
    'user_language_profile', 'language_history', 'redirect_click_query',
    'payments_query', 'settings_query'
  ];
  for (const name of requiredTests) {
    assert.match(smokeSource, new RegExp(`['"]${name}['"]`), `missing smoke test ${name}`);
  }
});
