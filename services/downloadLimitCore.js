function toValidLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function getActiveTariffCode(user, now = new Date()) {
  if (!user?.premium_until) return 'free';
  const premiumUntil = new Date(user.premium_until).getTime();
  const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(premiumUntil) || !Number.isFinite(nowTime) || premiumUntil <= nowTime) return 'free';
  const code = String(user.tariff_code || '').trim().toLowerCase();
  if (['plus', 'pro', 'unlimited'].includes(code)) return code;
  // Legacy classification only. premium_limit never becomes the effective limit.
  if (user.premium_limit === null) return 'unlimited';
  return Number(user.premium_limit) >= 100 ? 'pro' : 'plus';
}

export function isUserUnlimited(user, now = new Date()) {
  return getActiveTariffCode(user, now) === 'unlimited';
}

export function getEffectiveDownloadLimit(user, tariffLimits, now = new Date()) {
  const settings = tariffLimits && typeof tariffLimits === 'object' ? tariffLimits : { free: tariffLimits };
  const normalized = {
    free: toValidLimit(settings.free, 3), plus: toValidLimit(settings.plus, 30),
    pro: toValidLimit(settings.pro, 100), unlimited: toValidLimit(settings.unlimited, 10000)
  };
  const override = Number(user?.daily_limit_override);
  if (user?.daily_limit_override !== null && user?.daily_limit_override !== undefined && Number.isFinite(override) && override >= 0) return override;
  const tariff = getActiveTariffCode(user, now);
  return tariff === 'unlimited' ? Infinity : normalized[tariff];
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
