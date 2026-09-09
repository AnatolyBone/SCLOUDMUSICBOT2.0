import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildShazamDeduplicationKey,
  calculateShazamConversions,
  getShazamSource,
  parseShazamInlineResultId,
  tagShazamInlineResults,
  trackShazamEvent
} from '../services/shazamAnalyticsService.js';
import { getShazamAnalyticsData } from '../services/shazamReportService.js';

function context(source = 'voice', updateId = 123) {
  return {
    from: { id: 42 },
    update: { update_id: updateId },
    message: { [source]: { duration: 12, file_size: 3456 } }
  };
}

test('voice and video_note requests have stable dedupe and media metadata', async () => {
  for (const source of ['voice', 'video_note']) {
    const calls = [];
    const tracker = { trackEventSafe: async (...args) => calls.push(args) };
    const ctx = context(source);
    assert.equal(getShazamSource(ctx.message), source);
    await trackShazamEvent(ctx, 'shazam_request', {}, tracker);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], 'shazam_request');
    assert.equal(calls[0][3].source, source);
    assert.equal(calls[0][3].duration_sec, 12);
    assert.equal(calls[0][3].file_size, 3456);
    assert.equal(calls[0][3].deduplication_key, 'shazam_request:123');
  }
});

test('all Shazam funnel stages use one stable per-update dedupe key', async () => {
  const events = ['shazam_recognized', 'shazam_not_recognized', 'shazam_track_found', 'shazam_track_not_found', 'shazam_delivered'];
  const keys = events.map(event => buildShazamDeduplicationKey(event, 777));
  assert.deepEqual(keys, events.map(event => `${event}:777`));
  assert.equal(buildShazamDeduplicationKey('shazam_request', 777), buildShazamDeduplicationKey('shazam_request', 777));
  const analyticsSource = fs.readFileSync(new URL('../services/analyticsService.js', import.meta.url), 'utf8');
  assert.match(analyticsSource, /ON CONFLICT \(deduplication_key\)[\s\S]*DO NOTHING/);
});

test('analytics failures never break the Shazam user flow', async () => {
  const result = await trackShazamEvent(context(), 'shazam_request', {}, {
    trackEventSafe: async () => { throw new Error('database unavailable'); }
  });
  assert.equal(result, false);
});

test('only selected cached inline audio is attributed as delivered', () => {
  const tagged = tagShazamInlineResults([
    { type: 'audio', id: 'old', audio_file_id: 'file' },
    { type: 'article', id: 'live' }
  ], { source: 'video_note', updateId: 991 });
  assert.deepEqual(parseShazamInlineResultId(tagged[0].id), { source: 'video_note', updateId: '991' });
  assert.equal(tagged[1].id, 'live');
  assert.equal(parseShazamInlineResultId('live_result'), null);
});

test('zero denominators produce unavailable conversions, never division errors', () => {
  assert.deepEqual(calculateShazamConversions({}), {
    request_to_recognized: null,
    recognized_to_found: null,
    found_to_delivered: null,
    request_to_delivered: null
  });
});

test('pre-telemetry Shazam period is explicitly unavailable', async () => {
  const result = await getShazamAnalyticsData({
    query: async () => { throw new Error('query must not run'); },
    startDate: '2026-08-01',
    endDate: '2026-08-26'
  });
  assert.equal(result.available, false);
  assert.equal(result.summary, null);
  assert.ok(result.daily.every(row => row.available === false));
});

test('Shazam report ignores dates before telemetry and calculates safe metrics', async () => {
  const responses = [
    [{ users: 3, requests: 4, recognized: 2, not_recognized: 2, not_found: 1, found: 1, delivered: 1 }],
    [{ source: 'voice', users: 3, requests: 4, recognized: 2 }],
    [{ reason: 'no_match', count: 2 }],
    [{ day: '2026-08-27', users: 3, requests: 4, recognized: 2, found: 1, delivered: 1 }]
  ];
  let call = 0;
  const result = await getShazamAnalyticsData({
    query: async () => ({ rows: responses[call++] }),
    startDate: '2026-08-25',
    endDate: '2026-08-27'
  });
  assert.equal(result.effectiveStart, '2026-08-27');
  assert.equal(result.conversions.request_to_recognized, 0.5);
  assert.equal(result.bySource[0].success_rate, 0.5);
  assert.equal(result.reasons[0].share, 1);
  assert.equal(result.daily[0].available, false);
  assert.equal(result.daily[2].requests, 4);
});

test('Shazam events are included by the existing DAU/WAU/MAU activity predicate', () => {
  const dbSource = fs.readFileSync(new URL('../db.js', import.meta.url), 'utf8');
  assert.match(dbSource, /event_origin = 'live' AND event_name <> 'session_started'/);
  assert.doesNotMatch(dbSource, /event_name\s+IN\s*\([^)]*track_search_started[^)]*\)[\s\S]{0,100}COUNT\(DISTINCT user_id\).*AS dau/i);
});

test('bot wires every Shazam stage and chosen-result delivery', () => {
  const botSource = fs.readFileSync(new URL('../bot.js', import.meta.url), 'utf8');
  for (const event of ['shazam_request', 'shazam_recognized', 'shazam_not_recognized', 'shazam_track_found', 'shazam_track_not_found', 'shazam_delivered']) {
    assert.match(botSource, new RegExp(`trackShazamEvent\\([^)]*['\"]${event}['\"]`));
  }
  assert.match(botSource, /bot\.on\('chosen_inline_result'/);
});

test('XLSX generator creates a Shazam sheet without Excel formula errors', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-shazam-xlsx-'));
  const jsonPath = path.join(tempDir, 'input.json');
  const xlsxPath = path.join(tempDir, 'report.xlsx');
  const fixture = {
    startDate: '2026-08-25', endDate: '2026-08-27', requestedEndDate: '2026-08-27',
    period: {}, summary: {}, daily_stats: [], funnel: [], usage: [], tariffs: [], payments: [], campaigns: [], languages: [],
    payment_loss: {},
    shazam: {
      availableFrom: '2026-08-27', available: true,
      summary: { users: 1, requests: 1, recognized: 1, not_recognized: 0, not_found: 0, found: 1, delivered: 1 },
      conversions: { request_to_recognized: 1, recognized_to_found: 1, found_to_delivered: 1, request_to_delivered: 1 },
      bySource: [{ source: 'voice', users: 1, requests: 1, recognized: 1, success_rate: 1 }],
      reasons: [],
      daily: [
        { day: '2026-08-25', available: false },
        { day: '2026-08-27', available: true, users: 1, requests: 1, recognized: 1, found: 1, delivered: 1 }
      ]
    }
  };
  try {
    fs.writeFileSync(jsonPath, JSON.stringify(fixture));
    const generator = path.resolve(new URL('../scripts/generate_excel_report.py', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
    const generated = spawnSync('python', [generator, jsonPath, xlsxPath], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr || generated.stdout);
    const inspection = spawnSync('python', ['-c', [
      'import sys,zipfile',
      'z=zipfile.ZipFile(sys.argv[1])',
      "xml=''.join(z.read(n).decode('utf-8','ignore') for n in z.namelist() if n.endswith('.xml'))",
      "assert 'Shazam' in xml",
      "assert not any(e in xml for e in ['#REF!','#DIV/0!','#VALUE!','#NAME?','#N/A'])"
    ].join(';'), xlsxPath], { encoding: 'utf8' });
    assert.equal(inspection.status, 0, inspection.stderr || inspection.stdout);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
