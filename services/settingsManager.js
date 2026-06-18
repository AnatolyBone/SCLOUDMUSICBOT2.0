// НОВЫЙ ФАЙЛ: services/settingsManager.js

import { getAppSettings } from '../db.js';

let settingsCache = {};

// Дефолтные значения на случай, если в БД пусто
const DEFAULTS = {
  daily_limit_free: '3',
  daily_limit_plus: '30',
  daily_limit_pro: '100',
  daily_limit_unlim: '10000',
  playlist_limit_free: '3',
  playlist_limit_plus: '30',
  playlist_limit_pro: '100',
  playlist_limit_unlim: '10000',
  use_hybrid_worker: 'false', // Гибридная архитектура (воркер для Spotify/YouTube)
  use_spotify: 'true',        // Включен ли сервис Spotify
  use_youtube: 'true',        // Включен ли сервис YouTube
  use_soundcloud: 'true',     // Включен ли сервис SoundCloud
  maintenance_mode: 'false',  // Включен ли режим обслуживания
};

/**
 * Загружает настройки из БД в кеш
 */
export async function loadSettings() {
  console.log('[Settings] Загружаю настройки из БД...');
  try {
    const dbSettings = await getAppSettings();
    settingsCache = { ...DEFAULTS, ...dbSettings };
    console.log('[Settings] Настройки успешно загружены:', settingsCache);
  } catch (e) {
    console.error('[Settings] Не удалось загрузить настройки, использую дефолтные:', e.message);
    settingsCache = DEFAULTS;
  }
}

/**
 * Получает значение настройки из кеша
 * @param {string} key - Ключ настройки
 * @returns {string} Значение
 */
export function getSetting(key) {
  return settingsCache[key] || DEFAULTS[key];
}

/**
 * Возвращает все настройки
 */
export function getAllSettings() {
  return settingsCache;
}