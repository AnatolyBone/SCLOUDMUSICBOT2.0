import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ejs from 'ejs';

const workerManagerSource = await readFile(new URL('../services/workerManager.js', import.meta.url), 'utf8');
const workerSource = await readFile(new URL('../services/broadcastWorker.js', import.meta.url), 'utf8');
const managerSource = await readFile(new URL('../services/broadcastManager.js', import.meta.url), 'utf8');
const dbSource = await readFile(new URL('../db.js', import.meta.url), 'utf8');
const templateSource = await readFile(new URL('../views/broadcasts.ejs', import.meta.url), 'utf8');

test('broadcast worker creates a recipient snapshot before reading the first batch', () => {
  const claimIndex = workerSource.indexOf('const task = await getAndStartPendingBroadcastTask()');
  const snapshotIndex = workerSource.indexOf('const insertedRecipients = await createBroadcastSnapshot(');
  const batchIndex = workerSource.indexOf('const users = await getUsersForBroadcastBatch(');

  assert.ok(claimIndex >= 0, 'worker must claim a due broadcast task');
  assert.ok(snapshotIndex > claimIndex, 'snapshot must be created after the task is claimed');
  assert.ok(batchIndex > snapshotIndex, 'snapshot must be created before recipient batches are read');
  assert.match(workerSource, /if \(snapshotProgress\.total === 0\)/);
  assert.match(workerManagerSource, /await processNextBroadcastTask\(/);
});

test('broadcast snapshot creation is idempotent and reports inserted rows', () => {
  assert.match(dbSource, /ON CONFLICT \(broadcast_id, user_id\) DO NOTHING/);
  assert.match(dbSource, /return result\.rowCount \|\| 0/);
  assert.match(dbSource, /l\.audience_language_segment/);
  assert.match(dbSource, /status = 'processing'.*INTERVAL '35 minutes'/s);
});

test('delivery logging failures stop a batch before a pending row can be sent twice', () => {
  assert.match(managerSource, /BROADCAST_DELIVERY_LOG_FAILED/);
  assert.match(managerSource, /if \(e\.code === 'BROADCAST_DELIVERY_LOG_FAILED'\) throw e/);
  assert.doesNotMatch(managerSource, /catch \(logErr\) \{\}/);
  assert.match(workerSource, /will continue without an admin report/);
});

test('broadcast list renders a completed task with the sent counter', () => {
  assert.match(templateSource, /const sent = task\.sent_count \|\| 0/);

  const html = ejs.render(templateSource, {
    contentFor: () => '',
    tasks: [{
      id: 77,
      status: 'completed',
      target_audience: 'all_users',
      message: 'Regression test',
      scheduled_at: new Date('2026-07-13T12:00:00Z'),
      sent_count: 3,
      targeted_count: 4,
      processed_count: 4,
      estimated_count: 4
    }]
  });

  assert.match(html, /title="Отправлено: 3 из 4"/);
  assert.match(html, /style="width: 100%;"/);
});

test('legacy completed broadcasts render as archived completion without fabricated sent count', () => {
  const html = ejs.render(templateSource, {
    contentFor: () => '',
    tasks: [{
      id: 92,
      status: 'completed',
      target_audience: 'all_users',
      message: 'Legacy',
      scheduled_at: new Date('2026-07-13T12:00:00Z'),
      sent_count: 0,
      targeted_count: 0,
      processed_count: 0,
      estimated_count: 10_665
    }]
  });

  assert.match(html, /style="width: 100%;"/);
  assert.match(html, /100% архив/);
  assert.match(html, /детальная статистика до snapshot недоступна/);
  assert.doesNotMatch(html, /Отправлено: 0 из 10665/);
});
