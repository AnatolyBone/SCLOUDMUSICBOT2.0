// services/i18nService.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE, NEW_USER_FALLBACK_LANGUAGE } from '../config/languages.js';
import { allTextsSync } from '../config/texts.js';
import { interpolateTemplate } from './templateInterpolation.js';
export { interpolateTemplate } from './templateInterpolation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Локальный кэш файлов локалей
const locales = {};
try {
  for (const lang of SUPPORTED_LANGUAGES) {
    const filePath = path.join(__dirname, '..', 'locales', `${lang}.json`);
    if (fs.existsSync(filePath)) {
      let content = fs.readFileSync(filePath, 'utf8');
      if (content.charCodeAt(0) === 0xFEFF) {
        content = content.slice(1);
      }
      locales[lang] = JSON.parse(content);
    } else {
      console.warn(`[i18n] Файл локали не найден: ${filePath}`);
      locales[lang] = {};
    }
  }
} catch (e) {
  console.error('[i18n] Ошибка загрузки файлов локалей:', e.message);
}

/**
 * Возвращает языковой сегмент пользователя для рассылок: ru | en | unknown
 *
 * Правила (по приоритету):
 * 1. user_selected / admin_changed — доверяем language_code напрямую
 * 2. legacy_default — старая база до i18n: если language_code поддерживается (ru) → тот же сегмент
 * 3. telegram_auto — доверяем только если telegram_language_code тоже поддерживается
 * 4. Всё остальное → unknown
 */
export function getUserLanguageSegment(user) {
  if (!user) return 'unknown';
  const source = user.language_source || 'legacy_default';
  const langCode = user.language_code || 'ru';
  const telegramCode = user.telegram_language_code;

  // Источники с полным доверием к language_code
  if (['user_selected', 'admin_changed'].includes(source)) {
    return SUPPORTED_LANGUAGES.includes(langCode) ? langCode : 'unknown';
  }

  // Старая база: language_code был проставлен как 'ru' по умолчанию — считаем RU
  if (source === 'legacy_default') {
    return SUPPORTED_LANGUAGES.includes(langCode) ? langCode : 'unknown';
  }

  // telegram_auto: дополнительно проверяем исходный код Telegram
  if (source === 'telegram_auto') {
    if (!SUPPORTED_LANGUAGES.includes(langCode)) return 'unknown';
    if (telegramCode) {
      const cleanCode = telegramCode.toLowerCase().split('-')[0];
      // Если Telegram-код не входит в поддерживаемые группы → unknown
      const supportedTgCodes = ['ru', 'uk', 'be', 'kk', 'en'];
      if (!supportedTgCodes.includes(cleanCode)) return 'unknown';
    }
    return langCode;
  }

  return 'unknown';
}

/**
 * Нормализует языковой код Telegram согласно правилам
 * @param {string} code - Оригинальный telegram_language_code
 * @returns {string} Mapped language code
 */
export function normalizeLanguageCode(code) {
  if (!code) return NEW_USER_FALLBACK_LANGUAGE;
  const c = code.toLowerCase().split('-')[0];
  if (['ru', 'uk', 'be', 'kk'].includes(c)) return 'ru';
  if (c === 'en') return 'en';
  return NEW_USER_FALLBACK_LANGUAGE; // 'ru' по умолчанию
}

/**
 * Возвращает текущий язык пользователя (из колонки language_code)
 */
export function getUserLanguage(user) {
  if (user && user.language_code && SUPPORTED_LANGUAGES.includes(user.language_code)) {
    return user.language_code;
  }
  return DEFAULT_LANGUAGE;
}

/**
 * Перевод текста по ключу
 * @param {string} lang - Язык пользователя (например 'ru' или 'en')
 * @param {string} key - Ключ перевода
 * @param {Object} variables - Переменные для подстановки {{variable}}
 * @returns {string}
 */
export function translateWithTexts(lang, key, variables = {}, dbTextsOverride) {
  const targetLang = SUPPORTED_LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE;
  let text = null;

  // 1. Попытка получить переопределение из БД (bot_texts) для нужного языка
  try {
    const dbTexts = dbTextsOverride === undefined ? allTextsSync(targetLang) : dbTextsOverride;
    if (dbTexts && dbTexts[key]) {
      text = dbTexts[key];
    }
  } catch (dbErr) {
    // В случае ошибок загрузки из БД
  }

  // 2. Ищем в файле локали нужного языка
  if (!text) {
    text = locales[targetLang]?.[key];
  }

  // 3. Fallback на базовый язык (DEFAULT_LANGUAGE)
  if (!text && targetLang !== DEFAULT_LANGUAGE) {
    text = locales[DEFAULT_LANGUAGE]?.[key];
  }

  // 4. Если ключ отсутствует везде, пишем в лог и отдаем имя ключа
  if (!text) {
    console.error(`[i18n] Отсутствует перевод для ключа: "${key}" (язык: ${lang})`);
    text = key;
  }

  // 5. Подстановка переменных {{variable}}
  // Double braces are canonical; single braces remain compatible with legacy
  // bot_texts rows. Missing values are removed and logged without their values.
  return interpolateTemplate(text, variables, { key, lang: targetLang });
}

export function t(lang, key, variables = {}) {
  return translateWithTexts(lang, key, variables);
}
