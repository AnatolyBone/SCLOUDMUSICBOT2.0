import {
  isExpiredInlineQueryError,
  isTelegramInlineAudioTitleEmptyError
} from './telegramApiResilience.js';

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

      let delivered;
      try {
        delivered = await answer(ctx, results, { cache_time: 60 }, metadata);
      } catch (error) {
        if (!isTelegramInlineAudioTitleEmptyError(error)) throw error;

        logger.warn('[InlineQuery] Cached audio has empty title; using live fallback', metadata);
        if (!isCurrent()) return;

        try {
          results = await performSearch(query, userId, {
            liveTimeoutMs: liveSearchTimeoutMs,
            isCurrent,
            skipCache: true
          });
        } catch (fallbackSearchError) {
          logger.error('[InlineQuery] Live fallback search failed', fallbackSearchError);
          return;
        }
        if (!isCurrent()) return;

        try {
          delivered = await answer(ctx, results, { cache_time: 60 }, metadata);
        } catch (fallbackError) {
          if (!isTelegramInlineAudioTitleEmptyError(fallbackError)) throw fallbackError;
          logger.warn('[InlineQuery] Live fallback rejected with AUDIO_TITLE_EMPTY', metadata);
          return;
        }
      }
      if (!delivered) return;

      await onSearchCompleted({ ctx, query, userId, results });
    } finally {
      if (isCurrent()) currentQueries.delete(key);
    }
  };
}
