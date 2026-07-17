import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  classifyAcquisitionSource, getAcquisitionSourceExplorer, getRetentionExplorer,
  getUserTimeline, parseIsoDate, parseUserId, presentTimelineEvent
} from '../services/userInsightsService.js';

test('user insight validation accepts BIGINT ids and rejects unsafe input', () => {
  assert.equal(parseUserId('4294967296'), '4294967296');
  assert.throws(() => parseUserId('1 OR 1=1'), /положительным целым/);
  assert.throws(() => parseUserId('9223372036854775808'), /положительным целым/);
  assert.equal(parseIsoDate('2026-07-16', 'startDate'), '2026-07-16');
  assert.throws(() => parseIsoDate('2026-02-30', 'startDate'), /некорректную дату/);
});

test('sources normalize into distinct canonical categories', () => {
  assert.equal(classifyAcquisitionSource({ referrerId: '42' }), 'referrals');
  assert.equal(classifyAcquisitionSource({ referralSource: null }), 'unknown');
  assert.equal(classifyAcquisitionSource({ referralSource: 'direct' }), 'organic');
  assert.equal(classifyAcquisitionSource({ referralSource: 'yandex_promo' }), 'yandex');
});

test('timeline paginates BIGINT user events with a stable cursor', async () => {
  const calls = [];
  const fake = async (sql, params) => {
    calls.push({ sql, params });
    if (!sql.includes('WITH raw_events')) return { rows: [{ id: '4294967296', referral_source: 'organic' }] };
    return { rows: [{ event_key:'download:10', event_name:'download', event_category:'downloads', occurred_at:'2026-07-16T10:00:00Z', source_table:'downloads_log', details:{ track_title:'Track' } }] };
  };
  const result = await getUserTimeline('4294967296', { limit: 10 }, fake);
  assert.equal(result.events[0].label, 'Скачал трек');
  assert.deepEqual(calls[1].params, ['4294967296', null, null, null, null, 11]);
  assert.equal(result.pagination.limit, 10);
  await assert.rejects(getUserTimeline('4294967296', { limit: 201 }, fake), /limit.*1–200/);
  await assert.rejects(getUserTimeline('4294967296', { beforeOccurredAt:'2026-07-16T10:00:00Z' }, fake), /вместе/);
});

test('unknown timeline events have a safe presentation fallback', () => {
  const event = presentTimelineEvent({ event_key:'x:1', event_name:'future_event', source_table:'analytics_events' });
  assert.equal(event.label, 'Future event');
  assert.deepEqual(event.details, {});
});

test('retention aggregates and user lists execute separately and young cohorts return null', async () => {
  const summary = await getRetentionExplorer({ startDate:'2026-06-01', endDate:'2026-06-30' }, async () => ({ rows:[{
    cohort_size:200, eligible_d1:200, returned_d1:45, eligible_d7:180, returned_d7:30,
    eligible_d30:100, returned_d30:12, eligible_d90:0, returned_d90:0
  }] }));
  assert.equal(summary.summary.d1.notReturned, 155);
  assert.equal(summary.summary.d90.rate, null);
  const users = await getRetentionExplorer({ startDate:'2026-06-01', endDate:'2026-06-30', view:'users', day:1, segment:'not_returned', limit:50 }, async (_sql, params) => {
    assert.equal(params[3], 1); assert.equal(params[4], 'not_returned');
    return { rows:[{ user_id:'5967828789', username:'lost', total_downloads:'3', returned:false, reached_limit:true, opened_tariffs:true, received_broadcast:true, paid:false, filtered_count:155, referral_source:'yandex' }] };
  });
  assert.equal(users.pagination.total, 155);
  assert.equal(users.users[0].reachedLimit, true);
});

test('source explorer normalizes numerics, unique payer conversion, LTV and ARPPU', async () => {
  const result = await getAcquisitionSourceExplorer({ startDate:'2026-06-01', endDate:'2026-06-30' }, async sql => sql.includes('WITH settings')
    ? { rows:[{ source:'organic', registrations:'100', paying_users:'10', revenue_rub_equivalent:'2500.50', d7_eligible:'80', d7_returned:'20' }] }
    : { rows:[{ raw_source:'direct', normalized_source:'organic', registrations:'100' }] });
  assert.equal(result.sources[0].conversion, 10);
  assert.equal(result.sources[0].ltv, 25.005);
  assert.equal(result.sources[0].arppu, 250.05);
  assert.equal(result.sources[0].retentionD7, 25);
});

test('SQL and admin routes satisfy performance and security contracts', async () => {
  const source = await readFile(new URL('../services/userInsightsService.js', import.meta.url), 'utf8');
  const index = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const view = await readFile(new URL('../views/user-journey.ejs', import.meta.url), 'utf8');
  for (const table of ['analytics_events','payments','broadcast_log','broadcast_clicks','downloads_log','language_history','user_actions_log']) assert.match(source, new RegExp(`public\\.${table}`));
  assert.match(source, /ORDER BY occurred_at DESC, event_key DESC/);
  assert.match(source, /download_log_id/);
  assert.match(source, /payment_status = 'completed'/);
  assert.match(index, /app\.get\('\/admin\/api\/retention-explorer\/users', requireAuth/);
  assert.match(index, /app\.get\('\/admin\/api\/acquisition-sources', requireAuth/);
  assert.match(view, /Observed LTV/);
  assert.match(view, /Не вернулись к контрольному дню/);
  assert.doesNotMatch(view, /value="(?:250|500|1000)"/);
});
