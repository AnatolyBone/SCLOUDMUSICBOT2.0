import test from 'node:test';
import assert from 'node:assert/strict';

import { createKeyedTaskQueue } from '../services/keyedTaskQueue.js';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('tasks for one Shazam user execute sequentially and queue state is cleaned', async () => {
  const queue = createKeyedTaskQueue();
  const gate = deferred();
  const events = [];

  const a1 = queue.run('A', async () => {
    events.push('A1:start');
    await gate.promise;
    events.push('A1:end');
  });
  const a2 = queue.run('A', async () => events.push('A2'));
  const a3 = queue.run('A', async () => events.push('A3'));

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['A1:start']);
  assert.equal(queue.size, 1);
  gate.resolve();
  await Promise.all([a1, a2, a3]);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(events, ['A1:start', 'A1:end', 'A2', 'A3']);
  assert.equal(queue.size, 0);
});

test('Shazam queues for different users run in parallel', async () => {
  const queue = createKeyedTaskQueue();
  const gateA = deferred();
  const gateB = deferred();
  const started = [];

  const a = queue.run('A', async () => {
    started.push('A');
    await gateA.promise;
  });
  const b = queue.run('B', async () => {
    started.push('B');
    await gateB.promise;
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started.sort(), ['A', 'B']);
  gateA.resolve();
  gateB.resolve();
  await Promise.all([a, b]);
});
