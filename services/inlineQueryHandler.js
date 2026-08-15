import { isExpiredInlineQueryError } from './telegramApiResilience.js';

export function createInlineQueryHandler(options) {
  const {
    performSearch,
    debounceMs = 350,
    liveSearchTimeoutMs = 3500,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    logger = console,
    onSearchStarted = async () => {},
    onSearchCompleted = async () => {}
  } = options;
  const currentQueries = new Map();

  async function answer(ctx, results, extra, metadata) {
    try {
      await ctx.answerInlineQuery(results, extra);
      return true;
    } catch (error) {
      if (!isExpiredInlineQueryError(error)) throw error;
      logger.warn('[InlineQuery] Query expired', metadata);
      return false;
    }
  }

  return async function handleInlineQuery(ctx) {
    const query = String(ctx.inlineQuery?.query || '');
    const queryText = query.trim();
    const queryId = ctx.inlineQuery?.id;
    const userId = ctx.from?.id;
    const key = userId ?? `query:${queryId}`;
    const metadata = { userId, query: queryText.slice(0, 100), queryId };

    if (queryText.length < 3) {
      await answer(ctx, [], {
        switch_pm_text: 'Введите не менее 3 символов для поиска...',
        switch_pm_parameter: 'start'
      }, metadata);
      return;
    }

    currentQueries.set(key, queryId);
    const isCurrent = () => currentQueries.get(key) === queryId;

    try {
      await sleep(debounceMs);
      if (!isCurrent()) return;

      await onSearchStarted({ ctx, query, userId });
      if (!isCurrent()) return;

      let results;
      try {
        results = await performSearch(query, userId, {
          liveTimeoutMs: liveSearchTimeoutMs,
          isCurrent
        });
      } catch (error) {
        logger.error('[InlineQuery] Search failed', error);
        if (!isCurrent()) return;
        await answer(ctx, [], undefined, metadata);
        return;
      }

      if (!isCurrent()) return;
      const delivered = await answer(ctx, results, { cache_time: 60 }, metadata);
      if (!delivered) return;

      await onSearchCompleted({ ctx, query, userId, results });
    } finally {
      if (isCurrent()) currentQueries.delete(key);
    }
  };
}
