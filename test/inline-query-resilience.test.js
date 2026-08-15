import test from 'node:test';
import assert from 'node:assert/strict';

import { createInlineQueryHandler } from '../services/inlineQueryHandler.js';

function makeContext({ id, query, userId = 7, answer }) {
  return {
    inlineQuery: { id, query },
    from: { id: userId },
    answerInlineQuery: answer
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('expired inline answer is swallowed and never followed by a second answer', async () => {
  let answerCalls = 0;
  const handler = createInlineQueryHandler({
    performSearch: async () => [{ type: 'article', id: '1' }],
    sleep: async () => {},
    logger: { warn() {}, error() {} }
  });
  const ctx = makeContext({
    id: 'old',
    query: 'richter',
    answer: async () => {
      answerCalls += 1;
      throw new Error('query is too old and response timeout expired');
    }
  });

  await handler(ctx);
  assert.equal(answerCalls, 1);
});

test('a newer inline query prevents the old search result from answering', async () => {
  const oldSearch = deferred();
  const answers = [];
  const handler = createInlineQueryHandler({
    performSearch: async query => {
      if (query === 'richter') return oldSearch.promise;
      return [{ type: 'article', id: 'new' }];
    },
    sleep: async () => {},
    logger: { warn() {}, error() {} }
  });

  const oldRun = handler(makeContext({
    id: 'q1',
    query: 'richter',
    answer: async results => answers.push(['old', results])
  }));
  await Promise.resolve();
  const newRun = handler(makeContext({
    id: 'q2',
    query: 'richter remix',
    answer: async results => answers.push(['new', results])
  }));
  await newRun;
  oldSearch.resolve([{ type: 'article', id: 'old' }]);
  await oldRun;

  assert.deepEqual(answers, [['new', [{ type: 'article', id: 'new' }]]]);
});

test('unknown Telegram errors from inline answers still propagate', async () => {
  const expected = new Error('Bad Request: unexpected API contract failure');
  const handler = createInlineQueryHandler({
    performSearch: async () => [],
    sleep: async () => {},
    logger: { warn() {}, error() {} }
  });
  const ctx = makeContext({
    id: 'q1',
    query: 'richter',
    answer: async () => { throw expected; }
  });

  await assert.rejects(handler(ctx), error => error === expected);
});
