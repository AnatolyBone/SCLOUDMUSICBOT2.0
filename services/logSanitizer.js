const SENSITIVE_KEY_PATTERN = /(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|proxy(?:_url)?|database_url|redis_url|connection[_-]?string)/i;
const URL_WITH_CREDENTIALS_PATTERN = /\b(?:https?|socks\d?|postgres(?:ql)?|redis):\/\/[^\s/@:]+:[^\s/@]+@/gi;

function hasValue(value) {
  return value !== null && value !== undefined && value !== '';
}

export function redactSecretsInText(value) {
  if (value === null || value === undefined) return value;
  return String(value).replace(URL_WITH_CREDENTIALS_PATTERN, match => {
    const schemeEnd = match.indexOf('//') + 2;
    return `${match.slice(0, schemeEnd)}[REDACTED]@`;
  });
}

export function sanitizeLogValue(value, key = '', seen = new WeakSet()) {
  if (SENSITIVE_KEY_PATTERN.test(String(key))) {
    return hasValue(value) ? '[REDACTED]' : value;
  }

  if (typeof value === 'string') return redactSecretsInText(value);
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';

  seen.add(value);
  if (Array.isArray(value)) {
    return value.map(item => sanitizeLogValue(item, '', seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeLogValue(entryValue, entryKey, seen)
    ])
  );
}

export function formatSettingForLog(key, value) {
  return sanitizeLogValue(value, key);
}
