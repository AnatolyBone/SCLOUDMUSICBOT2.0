import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatInlineCachedAudioResults,
  isUsableInlineCachedTrack
} from '../services/inlineCachedAudioResults.js';

test('cached rows require non-empty file_id and meaningful title', () => {
  assert.equal(isUsableInlineCachedTrack({ file_id: 'file-1', title: 'Track' }), true);

  for (const title of [null, '', '   ', 'null', ' NULL ', 'undefined', ' Undefined ']) {
    assert.equal(isUsableInlineCachedTrack({ file_id: 'file-1', title }), false);
  }
  for (const file_id of [null, '', '   ', 'null', 'undefined']) {
    assert.equal(isUsableInlineCachedTrack({ file_id, title: 'Track' }), false);
  }
});

test('invalid cached rows never become cached audio inline results', () => {
  const results = formatInlineCachedAudioResults([
    { file_id: 'good-file', title: 'Track' },
    { file_id: 'bad-title', title: '   ' },
    { file_id: '', title: 'Missing file id' }
  ], {
    botUsername: 'SCloudMusicBot',
    randomBytes: () => Buffer.from('0102030405060708', 'hex')
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].audio_file_id, 'good-file');
  assert.equal(results[0].type, 'audio');
});
