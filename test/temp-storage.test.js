import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  assertTempCapacity,
  cleanupTempDirectory,
  removeTempArtifacts
} from '../services/tempStorage.js';

test('removeTempArtifacts removes all files from one downloader attempt only', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scloud-temp-test-'));
  try {
    fs.writeFileSync(path.join(directory, 'dl_attempt.mp3.part'), 'partial');
    fs.writeFileSync(path.join(directory, 'dl_attempt.webm'), 'source');
    fs.writeFileSync(path.join(directory, 'dl_other.mp3'), 'keep');
    assert.equal(removeTempArtifacts(directory, 'dl_attempt'), 2);
    assert.deepEqual(fs.readdirSync(directory), ['dl_other.mp3']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('cleanupTempDirectory removes stale files but preserves recent active files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scloud-temp-test-'));
  const now = Date.now();
  try {
    const stale = path.join(directory, 'stale.part');
    const recent = path.join(directory, 'recent.mp3');
    fs.writeFileSync(stale, Buffer.alloc(32));
    fs.writeFileSync(recent, Buffer.alloc(32));
    fs.utimesSync(stale, new Date(now - 120_000), new Date(now - 120_000));
    const result = cleanupTempDirectory(directory, { now, maxAgeMs: 60_000, maxBytes: 1024 });
    assert.equal(result.removed, 1);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(recent), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('assertTempCapacity blocks a new download at the configured ceiling', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scloud-temp-test-'));
  try {
    fs.writeFileSync(path.join(directory, 'active.mp3'), Buffer.alloc(16));
    assert.throws(() => assertTempCapacity(directory, 16), /TEMP_STORAGE_LIMIT/);
    assert.equal(assertTempCapacity(directory, 17), 16);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
