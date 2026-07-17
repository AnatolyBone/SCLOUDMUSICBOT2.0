function toValidLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function isUserUnlimited(user, now = new Date()) {
  if (!user || user.premium_limit !== null || !user.premium_until) return false;
  const premiumUntil = new Date(user.premium_until).getTime();
  const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return Number.isFinite(premiumUntil) && Number.isFinite(nowTime) && premiumUntil > nowTime;
}

export function getEffectiveDownloadLimit(user, freeLimit, now = new Date()) {
  const normalizedFreeLimit = toValidLimit(freeLimit, 3);
  if (isUserUnlimited(user, now)) return Infinity;

  const premiumUntil = user?.premium_until ? new Date(user.premium_until).getTime() : NaN;
  const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const premiumLimit = Number(user?.premium_limit);
  const hasActiveFinitePlan = Number.isFinite(premiumUntil)
    && Number.isFinite(nowTime)
    && premiumUntil > nowTime
    && user?.premium_limit !== null
    && Number.isFinite(premiumLimit)
    && premiumLimit >= 0;

  return hasActiveFinitePlan ? premiumLimit : normalizedFreeLimit;
}

export function isDownloadLimitReachedForUser(user, freeLimit, now = new Date()) {
  if (isUserUnlimited(user, now)) return false;
  const downloaded = toValidLimit(user?.downloads_today, 0);
  return downloaded >= getEffectiveDownloadLimit(user, freeLimit, now);
}

export function getRemainingDownloads(user, freeLimit, now = new Date()) {
  const limit = getEffectiveDownloadLimit(user, freeLimit, now);
  if (!Number.isFinite(limit)) return Infinity;
  const downloaded = toValidLimit(user?.downloads_today, 0);
  return Math.max(0, limit - downloaded);
}

export function getDownloadQueuePriority(user, freeLimit, now = new Date()) {
  const limit = getEffectiveDownloadLimit(user, freeLimit, now);
  return Number.isFinite(limit) ? limit : 10000;
}

