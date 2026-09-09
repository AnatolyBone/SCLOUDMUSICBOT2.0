const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_SAFETY_BUFFER_MS = 200;
const DEFAULT_USER_INTERVAL_MS = 1200;

const RATE_LIMITED_SEND_METHODS = Object.freeze([
  'sendMessage',
  'sendAudio',
  'sendPhoto',
  'sendVideo',
  'sendDocument',
  'sendMediaGroup',
  'sendAnimation'
]);

const RETRY_ONLY_METHODS = Object.freeze([
  'getFileLink',
  'deleteMessage',
  'editMessageText'
]);

const INSTALL_MARKER = Symbol('telegramApiResilienceInstalled');

function getTelegramDescription(error) {
  return String(
    error?.response?.description ||
    error?.description ||
    error?.message ||
    ''
  );
}

export function getTelegramRetryAfter(error) {
  const value =
    error?.response?.parameters?.retry_after ??
    error?.parameters?.retry_after ??
    error?.retry_after;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export function isTelegramRateLimitError(error) {
  const code = Number(error?.response?.error_code ?? error?.error_code ?? error?.code);
  return code === 429 || /too many requests|retry after/i.test(getTelegramDescription(error));
}

export function isExpiredInlineQueryError(error) {
  const description = getTelegramDescription(error);
  return /query is too old|response timeout expired|query id is invalid/i.test(description);
}

export function isTelegramInlineAudioTitleEmptyError(error) {
  const descriptions = [
    error?.response?.description,
    error?.description,
    error?.message
  ];

  return descriptions.some(description =>
    /(?:^|[^a-z0-9_])AUDIO_TITLE_EMPTY(?:$|[^a-z0-9_])/i.test(String(description || ''))
  );
}

export function isExpectedTelegramTransientError(error) {
  return isTelegramRateLimitError(error) || isExpiredInlineQueryError(error);
}

export function shouldSuppressTelegramErrorInGlobalHandler(error, ctx) {
  return isExpectedTelegramTransientError(error) ||
    (Boolean(ctx?.inlineQuery) && isTelegramInlineAudioTitleEmptyError(error));
}

export async function withTelegramRetry(operation, options = {}) {
  const {
    method = 'unknown',
    chatId = null,
    maxRetries = DEFAULT_MAX_RETRIES,
    safetyBufferMs = DEFAULT_SAFETY_BUFFER_MS,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    logger = console
  } = options;

  let retries = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isTelegramRateLimitError(error) || retries >= maxRetries) throw error;

      const retryAfter = getTelegramRetryAfter(error) ?? 1;
      const delayMs = Math.max(0, retryAfter * 1000 + safetyBufferMs);
      retries += 1;
      logger.warn('[Telegram] Rate limited', {
        chatId,
        method,
        retryAfter,
        retry: retries,
        maxRetries
      });
      await sleep(delayMs);
    }
  }
}

export function createTelegramApiController(options = {}) {
  const {
    minUserIntervalMs = DEFAULT_USER_INTERVAL_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    safetyBufferMs = DEFAULT_SAFETY_BUFFER_MS,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    now = () => Date.now(),
    logger = console
  } = options;
  const lastSentTimes = new Map();
  const userQueues = new Map();

  const execute = (operation, metadata = {}) => withTelegramRetry(operation, {
    ...metadata,
    maxRetries,
    safetyBufferMs,
    sleep,
    logger
  });

  function send(chatId, method, operation) {
    const numericChatId = Number(chatId);
    if (!Number.isFinite(numericChatId) || numericChatId < 0) {
      return execute(operation, { chatId, method });
    }

    const previous = userQueues.get(numericChatId) || Promise.resolve();
    const request = previous.catch(() => {}).then(async () => {
      const elapsed = now() - (lastSentTimes.get(numericChatId) || 0);
      const delayMs = minUserIntervalMs - elapsed;
      if (delayMs > 0) await sleep(delayMs);

      const result = await execute(operation, { chatId: numericChatId, method });
      lastSentTimes.set(numericChatId, now());
      return result;
    });
    const tail = request.catch(() => {});
    userQueues.set(numericChatId, tail);
    tail.finally(() => {
      if (userQueues.get(numericChatId) === tail) userQueues.delete(numericChatId);
    });
    return request;
  }

  return {
    send,
    execute,
    get activeUserQueues() {
      return userQueues.size;
    }
  };
}

export function installTelegramApiResilience(telegram, options = {}) {
  if (!telegram || telegram[INSTALL_MARKER]) return telegram;

  const controller = createTelegramApiController(options);
  for (const method of RATE_LIMITED_SEND_METHODS) {
    if (typeof telegram[method] !== 'function') continue;
    const original = telegram[method].bind(telegram);
    telegram[method] = (chatId, ...args) =>
      controller.send(chatId, method, () => original(chatId, ...args));
  }

  for (const method of RETRY_ONLY_METHODS) {
    if (typeof telegram[method] !== 'function') continue;
    const original = telegram[method].bind(telegram);
    telegram[method] = (...args) =>
      controller.execute(() => original(...args), { method });
  }

  Object.defineProperty(telegram, INSTALL_MARKER, { value: controller });
  return telegram;
}
