import { t as i18n, normalizeLanguageCode } from './i18nService.js';
import { TARIFFS } from '../config/tariffs.js';

function getTariffVariables() {
  return {
    plus_limit: TARIFFS.plus.dailyLimit,
    plus_price_xtr: TARIFFS.plus.priceXtr,
    pro_limit: TARIFFS.pro.dailyLimit,
    pro_price_xtr: TARIFFS.pro.priceXtr,
    unlim_price_xtr: TARIFFS.unlim.priceXtr,
    period_days: TARIFFS.plus.periodDays
  };
}

function buildTariffKeyboard(language) {
  return [
    [{
      text: `⭐ Plus — ${TARIFFS.plus.priceXtr} Stars`,
      callback_data: 'buy_plan_plus'
    }],
    [{
      text: `🔥 Pro — ${TARIFFS.pro.priceXtr} Stars`,
      callback_data: 'buy_plan_pro'
    }],
    [{
      text: `💎 Unlimited — ${TARIFFS.unlim.priceXtr} Stars`,
      callback_data: 'buy_plan_unlim'
    }],
    [{
      text: i18n(language, 'pay_by_card_button'),
      callback_data: 'other_payment_methods'
    }]
  ];
}

export function buildUpgradeOffer({ lang = 'ru' } = {}) {
  const language = normalizeLanguageCode(lang);
  return {
    text: i18n(language, 'upgrade_info_compact', getTariffVariables()),
    extra: {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: buildTariffKeyboard(language) }
    }
  };
}

export function buildLimitUpsell({
  lang = 'ru',
  channelUsername = '',
  bonusAvailable = false,
  user = null,
  freeLimit = 3,
  now = new Date()
} = {}) {
  const language = normalizeLanguageCode(lang);
  const cleanUsername = String(channelUsername || '').replace(/^@/, '').trim();
  const canClaimBonus = Boolean(bonusAvailable && cleanUsername);
  const premiumUntil = user?.premium_until ? new Date(user.premium_until).getTime() : NaN;
  const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const hasActivePlan = Number.isFinite(premiumUntil)
    && Number.isFinite(nowTime)
    && premiumUntil > nowTime;
  const configuredFreeLimit = Number(freeLimit);
  const safeFreeLimit = Number.isFinite(configuredFreeLimit) && configuredFreeLimit >= 0
    ? configuredFreeLimit
    : 3;
  const configuredPlanLimit = Number(user?.premium_limit);
  const dailyLimit = hasActivePlan
    && user?.premium_limit !== null
    && Number.isFinite(configuredPlanLimit)
    && configuredPlanLimit >= 0
    ? configuredPlanLimit
    : safeFreeLimit;
  const textKey = hasActivePlan
    ? (canClaimBonus ? 'limit_upsell_plan_with_bonus' : 'limit_upsell_plan_without_bonus')
    : (canClaimBonus ? 'limit_upsell_free_with_bonus' : 'limit_upsell_free_without_bonus');
  const reasonText = i18n(language, textKey, {
    channel_username: cleanUsername ? `@${cleanUsername}` : '',
    daily_limit: dailyLimit
  });
  const offer = buildUpgradeOffer({ lang: language });
  const inlineKeyboard = [...offer.extra.reply_markup.inline_keyboard];

  if (canClaimBonus) {
    inlineKeyboard.push([{
      text: i18n(language, 'limit_bonus_button'),
      callback_data: 'check_subscription'
    }]);
  }

  return {
    text: `${reasonText}\n\n${offer.text}`,
    extra: {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: inlineKeyboard }
    }
  };
}
