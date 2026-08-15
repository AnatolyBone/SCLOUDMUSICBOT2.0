import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTelegramApiController,
  installTelegramApiResilience,
  isExpiredInlineQueryError,
  withTelegramRetry
} from '../services/telegramApiResilience.js';

function rateLimitError(retryAfter = 3) {
  const error = new Error(`429: Too Many Requests: retry after ${retryAfter}`);
  error.response = {
    error_code: 429,
    description: 'Too Many Requests',
    parameters: { retry_after: retryAfter }
  };
  return error;
}

test('Telegram 429 waits retry_after plus buffer and retries successfully', async () => {
  const waits = [];
  let calls = 0;
  const result = await withTelegramRetry(async () => {
    calls += 1;
    if (calls === 1) throw rateLimitError(3);
    return 'sent';
  }, {
    sleep: async ms => waits.push(ms),
    safetyBufferMs: 200,
    logger: { warn() {} }
  });

  assert.equal(result, 'sent');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [3200]);
});

test('Telegram retry is bounded and unknown errors are rethrown', async () => {
  let calls = 0;
  await assert.rejects(withTelegramRetry(async () => {
    calls += 1;
    throw rateLimitError(1);
  }, {
    maxRetries: 2,
    sleep: async () => {},
    logger: { warn() {} }
  }), /Too Many Requests/);
  assert.equal(calls, 3);

  const unknown = new Error('unexpected Telegram transport failure');
  await assert.rejects(withTelegramRetry(async () => {
    throw unknown;
  }, { sleep: async () => {} }), error => error === unknown);
});

test('selected user-facing send methods are centrally protected', async () => {
  const calls = [];
  const telegram = {};
  for (const method of ['sendMessage', 'sendAudio', 'sendPhoto', 'sendVideo', 'sendDocument', 'sendMediaGroup']) {
    telegram[method] = async chatId => {
      calls.push([method, chatId]);
      return method;
    };
  }

  installTelegramApiResilience(telegram, {
    minUserIntervalMs: 0,
    sleep: async () => {},
    logger: { warn() {} }
  });
  await Promise.all([
    telegram.sendMessage(42, 'hello'),
    telegram.sendPhoto(42, 'photo'),
    telegram.sendMediaGroup(-100123, [])
  ]);

  assert.deepEqual(calls, [
    ['sendMediaGroup', -100123],
    ['sendMessage', 42],
    ['sendPhoto', 42]
  ]);
});

test('service channels bypass per-user pacing', async () => {
  const waits = [];
  const controller = createTelegramApiController({
    minUserIntervalMs: 1200,
    sleep: async ms => waits.push(ms)
  });
  await controller.send(-100123, 'sendAudio', async () => 'stored');
  assert.deepEqual(waits, []);
});

test('inline expiry classifier recognizes Telegram variants', () => {
  assert.equal(isExpiredInlineQueryError(new Error('query is too old and response timeout expired')), true);
  assert.equal(isExpiredInlineQueryError(new Error('Bad Request: query ID is invalid')), true);
  assert.equal(isExpiredInlineQueryError(new Error('Bad Request: message is not modified')), false);
});
