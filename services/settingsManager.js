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
  use_vpn: 'true',            // Отображать ли кнопку VPN
  vpn_button_text: '🔐 VPN (YouTube 4K)',
  vpn_message_text: '🚀 <b>YouTube тормозит, а Spotify не работает?</b>\n\n' +
    'Рекомендую VPN, которым пользуюсь сам — <b>South Networks</b>.\n\n' +
    '✅ YouTube в 4K без лагов\n' +
    '✅ Instagram, Netflix, Spotify\n' +
    '✅ Высокая скорость (приватные серверы)\n\n' +
    '🎁 <b>Дают 2 дня бесплатного теста</b> всем новым пользователям. Попробуйте сами:',
  vpn_button_url_text: '⚡️ Попробовать бесплатно',
  vpn_link: 'https://t.me/southnetworksvpnbot?start=783629145',
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