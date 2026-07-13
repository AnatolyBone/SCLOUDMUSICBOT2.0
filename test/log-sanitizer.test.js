import assert from 'node:assert/strict';
import test from 'node:test';

import { formatSettingForLog, redactSecretsInText, sanitizeLogValue } from '../services/logSanitizer.js';

test('configuration logging redacts proxy credentials and other secrets', () => {
  const sanitized = sanitizeLogValue({
    proxy_url: 'http://alice:secret@example.com:8080',
    nested: { DATABASE_URL: 'postgresql://user:password@example.com/db' },
    daily_limit_free: '3'
  });

  assert.equal(sanitized.proxy_url, '[REDACTED]');
  assert.equal(sanitized.nested.DATABASE_URL, '[REDACTED]');
  assert.equal(sanitized.daily_limit_free, '3');
  assert.doesNotMatch(JSON.stringify(sanitized), /alice|secret|password/);
});

test('free-form proxy errors cannot leak URL credentials', () => {
  const output = redactSecretsInText('Proxy failed: http://alice:secret@example.com:8080 request aborted');
  assert.equal(output, 'Proxy failed: http://[REDACTED]@example.com:8080 request aborted');
  assert.equal(formatSettingForLog('proxy_url', 'http://alice:secret@example.com'), '[REDACTED]');
});
