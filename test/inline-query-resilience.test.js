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
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('valid cached results are answered once without fallback', async () => {
  const searchCalls = [];
  let answerCalls = 0;
  const cached = [{ type: 'audio', id: 'cached', audio_file_id: 'file-id' }];
  const handler = createInlineQueryHandler({
    performSearch: async (...args) => {
      searchCalls.push(args);
      return cached;
    },
    sleep: async () => {},
    logger: { warn() {}, error() {} }
  });

  await handler(makeContext({
    id: 'q1',
    query: 'unstoppable',
    answer: async results => {
      answerCalls += 1;
      assert.equal(results, cached);
    }
  }));

  assert.equal(answerCalls, 1);
  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0][2].skipCache, undefined);
});

test('AUDIO_TITLE_EMPTY retries once with a skip-cache live search', async () => {
  const searchOptions = [];
  const answers = [];
  const cached = [{ type: 'audio', id: 'cached' }];
  const live = [{ type: 'article', id: 'live', title: 'Unstoppable' }];
  const handler = createInlineQueryHandler({
    performSearch: async (_query, _userId, options) => {
      searchOptions.push(options);
      return options.skipCache ? live : cached;
    },
    sleep: async () => {},
    logger: { warn() {}, error() {} }
  });

  await handler(makeContext({
    id: 'q1',
    query: 'unstoppable',
    answer: async results => {
      answers.push(results);
      if (answers.length === 1) throw new Error('400: Bad Request: AUDIO_TITLE_EMPTY');
    }
  }));

  assert.deepEqual(answers, [cached, live]);
  assert.equal(searchOptions.length, 2);
  assert.equal(searchOptions[0].skipCache, undefined);
  assert.equal(searchOptions[1].skipCache, true);
});

test('superseded query does not start live fallback after AUDIO_TITLE_EMPTY', async () => {
  const oldAnswer = deferred();
  const oldAnswerStarted = deferred();
  const searchCalls = [];
  const handler = createInlineQueryHandler({
    performSearch: async (query, _userId, options) => {
      searchCalls.push({ query, skipCache: options.skipCache });
      return [{ type: 'article', id: query }];
    },
    sleep: async () => {},
    logger: { warn() {}, error() {} }
  });

  const oldRun = handler(makeContext({
    id: 'q1',
    query: 'unstoppa',
    answer: async () => {
      oldAnswerStarted.resolve();
      return oldAnswer.promise;
    }
  }));
  await oldAnswerStarted.promise;

  await handler(makeContext({
    id: 'q2',
    query: 'unstoppable',
    answer: async () => {}
  }));
  oldAnswer.reject(new Error('400: Bad Request: AUDIO_TITLE_EMPTY'));
  await oldRun;

  assert.equal(searchCalls.filter(call => call.skipCache === true).length, 0);
});

test('AUDIO_TITLE_EMPTY fallback is attempted at most once', async () => {
  let searchCalls = 0;
  let answerCalls = 0;
  const handler = createInlineQueryHandler({
    performSearch: async (_query, _userId, options) => {
      searchCalls += 1;
      return [{ type: options.skipCache ? 'article' : 'audio', id: String(searchCalls) }];
    },
    sleep: async () => {},
    logger: { warn() {}, error() {} }
  });

  await handler(makeContext({
    id: 'q1',
    query: 'unstoppable',
    answer: async () => {
      answerCalls += 1;
      throw { response: { description: 'Bad Request: AUDIO_TITLE_EMPTY' } };
    }
  }));

  assert.equal(searchCalls, 2);
  assert.equal(answerCalls, 2);
});

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
