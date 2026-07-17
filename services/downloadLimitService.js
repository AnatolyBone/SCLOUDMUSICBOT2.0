import { getSetting } from './settingsManager.js';
import {
  getDownloadQueuePriority as getQueuePriority,
  getEffectiveDownloadLimit as getEffectiveLimit,
  getRemainingDownloads as getRemaining,
  isDownloadLimitReachedForUser as isLimitReached,
  isUserUnlimited
} from './downloadLimitCore.js';

export { isUserUnlimited };

export function getConfiguredFreeDownloadLimit() {
  const parsed = Number(getSetting('daily_limit_free'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3;
}

export function getEffectiveDownloadLimit(user, freeLimit = getConfiguredFreeDownloadLimit(), now = new Date()) {
  return getEffectiveLimit(user, freeLimit, now);
}

export function isDownloadLimitReachedForUser(user, freeLimit = getConfiguredFreeDownloadLimit(), now = new Date()) {
  return isLimitReached(user, freeLimit, now);
}

export function getRemainingDownloads(user, freeLimit = getConfiguredFreeDownloadLimit(), now = new Date()) {
  return getRemaining(user, freeLimit, now);
}

export function getDownloadQueuePriority(user, freeLimit = getConfiguredFreeDownloadLimit(), now = new Date()) {
  return getQueuePriority(user, freeLimit, now);
}

