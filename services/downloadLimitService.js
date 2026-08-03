import { getSetting } from './settingsManager.js';
import {
  getActiveTariffCode,
  getDownloadQueuePriority as getQueuePriority,
  getEffectiveDownloadLimit as getEffectiveLimit,
  getRemainingDownloads as getRemaining,
  isDownloadLimitReachedForUser as isLimitReached,
  isUserUnlimited
} from './downloadLimitCore.js';

export { getActiveTariffCode, isUserUnlimited };

export function getConfiguredFreeDownloadLimit() {
  const parsed = Number(getSetting('daily_limit_free'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3;
}

export function getConfiguredTariffLimits() {
  return {
    free: getConfiguredFreeDownloadLimit(),
    plus: Number(getSetting('daily_limit_plus')) || 30,
    pro: Number(getSetting('daily_limit_pro')) || 100,
    unlimited: Number(getSetting('daily_limit_unlimited') || getSetting('daily_limit_unlim')) || 10000
  };
}

export function getEffectiveDownloadLimit(user, freeLimit = getConfiguredFreeDownloadLimit(), now = new Date()) {
  return getEffectiveLimit(user, getConfiguredTariffLimits(), now);
}

export function isDownloadLimitReachedForUser(user, freeLimit = getConfiguredFreeDownloadLimit(), now = new Date()) {
  return isLimitReached(user, getConfiguredTariffLimits(), now);
}

export function getRemainingDownloads(user, freeLimit = getConfiguredFreeDownloadLimit(), now = new Date()) {
  return getRemaining(user, getConfiguredTariffLimits(), now);
}

export function getDownloadQueuePriority(user, freeLimit = getConfiguredFreeDownloadLimit(), now = new Date()) {
  return getQueuePriority(user, getConfiguredTariffLimits(), now);
}
