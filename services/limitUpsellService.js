import { t as i18n, normalizeLanguageCode } from './i18nService.js';

export function buildLimitUpsell({ lang = 'ru', channelUsername = '', bonusAvailable = false } = {}) {
  const language = normalizeLanguageCode(lang);
  const cleanUsername = String(channelUsername || '').replace(/^@/, '').trim();
  const canClaimBonus = Boolean(bonusAvailable && cleanUsername);
  const textKey = canClaimBonus ? 'limit_upsell_with_bonus' : 'limit_upsell_without_bonus';
  const text = i18n(language, textKey, {
    channel_username: cleanUsername ? `@${cleanUsername}` : ''
  });
  const inlineKeyboard = [];

  if (canClaimBonus) {
    inlineKeyboard.push([{
      text: i18n(language, 'limit_bonus_button'),
      callback_data: 'check_subscription'
    }]);
  }
  inlineKeyboard.push([{
    text: i18n(language, 'limit_tariffs_button'),
    callback_data: 'open_tariffs_limit'
  }]);

  return {
    text,
    extra: {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: inlineKeyboard }
    }
  };
}
