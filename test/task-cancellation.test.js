import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { TaskQueue } from '../lib/TaskQueue.js';
import { bindAbortSignal, terminateChildProcess } from '../services/abortableProcess.js';

class FakeChild extends EventEmitter {
  constructor({ exitOnTerm = true } = {}) {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.exitOnTerm = exitOnTerm;
    this.signals = [];
  }

  kill(signal) {
    this.signals.push(signal);
    if (signal === 'SIGTERM' && !this.exitOnTerm) return true;
    this.signalCode = signal;
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
}

test('abort sends SIGTERM and does not escalate after graceful child exit', async () => {
  const child = new FakeChild();
  const controller = new AbortController();
  bindAbortSignal(child, controller.signal, { graceMs: 20 });
  controller.abort(new Error('TASK_TIMEOUT'));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(child.signalCode, 'SIGTERM');
});

test('terminateChildProcess escalates to SIGKILL after grace period', async () => {
  const child = new FakeChild({ exitOnTerm: false });
  await terminateChildProcess(child, { graceMs: 20 });
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(child.signalCode, 'SIGKILL');
});

test('TaskQueue aborts timed out processor and waits for its cleanup', async () => {
  let aborted = false;
  let cleanupComplete = false;
  const queue = new TaskQueue({
    maxConcurrent: 1,
    taskTimeout: 15,
    taskProcessor: (_task, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => {
        aborted = true;
        setTimeout(() => {
          cleanupComplete = true;
          resolve();
        }, 20);
      }, { once: true });
    })
  });

  await assert.rejects(queue.add({ url: 'https://example.test/track' }), /TASK_TIMEOUT/);
  assert.equal(aborted, true);
  assert.equal(cleanupComplete, true);
  await queue.onIdle();
  assert.equal(queue.pending, 0);
  assert.equal(queue.getStats().timeouts, 1);
});

test('download pipelines propagate AbortSignal and isolate yt-dlp in a process group', async () => {
  const manager = await readFile(new URL('../services/downloadManager.js', import.meta.url), 'utf8');
  const spotify = await readFile(new URL('../services/spotifyDownloader.js', import.meta.url), 'utf8');
  assert.match(manager, /trackDownloadProcessor\(task, signal = null\)/);
  assert.match(manager, /downloadWithYtdlp\(fullUrl, quality, true, signal\)/);
  assert.match(manager, /if \(signal\?\.aborted\) throw abortError\(signal\)/);
  assert.match(manager, /detached: processGroup/);
  assert.match(spotify, /bindAbortSignal\(ytdlp, signal, \{ processGroup \}\)/);
  assert.match(spotify, /removeTempArtifacts\(TEMP_DIR, baseName\)/);
});
