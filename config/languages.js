// config/languages.js
export const SUPPORTED_LANGUAGES = ['ru', 'en'];
export const DEFAULT_LANGUAGE = 'ru';
export const NEW_USER_FALLBACK_LANGUAGE = 'ru';

export const LANGUAGE_LABELS = {
  ru: '🇷🇺 Русский',
  en: '🇬🇧 English'
};

/**
 * Нормализует языковой код Telegram согласно правилам
 */
export function normalizeLanguageCode(code) {
  if (!code) return NEW_USER_FALLBACK_LANGUAGE;
  const c = code.toLowerCase().split('-')[0];
  if (['ru', 'uk', 'be', 'kk'].includes(c)) return 'ru';
  if (c === 'en') return 'en';
  return NEW_USER_FALLBACK_LANGUAGE; // 'ru' по умолчанию
}

/**
 * Возвращает языковой сегмент пользователя для рассылок: ru | en | unknown
 *
 * Правила:
 * 1. user_selected / admin_changed → доверяем language_code напрямую
 * 2. legacy_default → старая база, language_code = 'ru' → RU-сегмент
 * 3. telegram_auto → проверяем telegram_language_code (только ru/uk/be/kk/en группы)
 * 4. Остальное → unknown
 */
export function getUserLanguageSegment(user) {
  if (!user) return 'unknown';
  const source = user.language_source || 'legacy_default';
  const langCode = user.language_code || 'ru';
  const telegramCode = user.telegram_language_code;

  if (['user_selected', 'admin_changed', 'legacy_default'].includes(source)) {
    return SUPPORTED_LANGUAGES.includes(langCode) ? langCode : 'unknown';
  }

  if (source === 'telegram_auto') {
    if (!SUPPORTED_LANGUAGES.includes(langCode)) return 'unknown';
    if (telegramCode) {
      const cleanCode = telegramCode.toLowerCase().split('-')[0];
      const supportedTgCodes = ['ru', 'uk', 'be', 'kk', 'en'];
      if (!supportedTgCodes.includes(cleanCode)) return 'unknown';
    }
    return langCode;
  }

  return 'unknown';
}
