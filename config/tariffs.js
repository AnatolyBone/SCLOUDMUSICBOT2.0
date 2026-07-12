// config/tariffs.js

export const TARIFFS = {
  plus: {
    planId: 'plus',
    name: 'Plus',
    dailyLimit: 30,
    isUnlimited: false,
    priceXtr: 79,
    priceRub: 119,
    periodDays: 30,
    isActive: true,
    isRecurring: false
  },
  pro: {
    planId: 'pro',
    name: 'Pro',
    dailyLimit: 100,
    isUnlimited: false,
    priceXtr: 129,
    priceRub: 199,
    periodDays: 30,
    isActive: true,
    isRecurring: false
  },
  unlim: {
    planId: 'unlim',
    name: 'Unlimited',
    dailyLimit: null, // null означает безлимитный тариф
    isUnlimited: true,
    priceXtr: 199,
    priceRub: 299,
    periodDays: 30,
    isActive: true,
    isRecurring: false
  }
};

/**
 * Возвращает тариф по его ID
 */
export function getTariff(planId) {
  return TARIFFS[planId] || null;
}
