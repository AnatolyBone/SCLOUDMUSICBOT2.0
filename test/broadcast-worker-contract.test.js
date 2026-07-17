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
  assert.match(dbSource, /status = 'pending'.*launch_confirmed_at IS NOT NULL/s);
});

test('delivery logging failures stop a batch before a pending row can be sent twice', () => {
  assert.match(managerSource, /BROADCAST_DELIVERY_LOG_FAILED/);
  assert.match(managerSource, /if \(e\.code === 'BROADCAST_DELIVERY_LOG_FAILED'\) throw e/);
  assert.doesNotMatch(managerSource, /catch \(logErr\) \{\}/);
  assert.match(workerSource, /will continue without an admin report/);
});

test('broadcast progress is based only on sent / total and never jumps to 100 early', () => {
  assert.match(templateSource, /const sent = task\.sent_count \|\| 0/);

  const html = ejs.render(templateSource, {
    contentFor: () => '',
    broadcastsEnabled: true,
    tasks: [{
      id: 77,
      status: 'completed',
      target_audience: 'all_users',
      message: 'Regression test',
      scheduled_at: new Date('2026-07-13T12:00:00Z'),
      sent_count: 10_542,
      targeted_count: 10_631,
      processed_count: 10_631,
      estimated_count: 10_631
    }]
  });

  assert.match(html, /title="Отправлено: 10542 из 10631"/);
  assert.match(html, /10542 \/ 10631 \(99,2%\)/);
  assert.match(html, /style="width: 99\.16%;"/);
  assert.doesNotMatch(html, /style="width: 100%;"/);
});

test('legacy completed broadcasts render as archived completion without fabricated sent count', () => {
  const html = ejs.render(templateSource, {
    contentFor: () => '',
    broadcastsEnabled: true,
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

  assert.match(html, /style="width: 0%;"/);
  assert.match(html, /0 \/ 10665 \(0%\) · архив/);
  assert.match(html, /детальная статистика до snapshot недоступна/);
  assert.doesNotMatch(html, /style="width: 100%;"/);
});

test('broadcast progress shows completed only when every recipient was sent', () => {
  const html = ejs.render(templateSource, {
    contentFor: () => '',
    broadcastsEnabled: true,
    tasks: [{
      id: 99,
      status: 'completed',
      target_audience: 'all_users',
      message: 'Done',
      scheduled_at: new Date('2026-07-13T12:00:00Z'),
      sent_count: 10_631,
      targeted_count: 10_631,
      processed_count: 10_631,
      estimated_count: 10_631
    }]
  });

  assert.match(html, /style="width: 100%;"/);
  assert.match(html, /Завершено · 10631 \/ 10631 \(100%\)/);
});
