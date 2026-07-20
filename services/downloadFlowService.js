function normalizeUrlForClaim(value) {
  try {
    const url = new URL(String(value));
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || ['si', 'fbclid', 'gclid'].includes(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return String(value || '').trim();
  }
}

export function getDownloadCorrelationId(ctx) {
  const updateId = ctx?.update?.update_id ?? ctx?.update_id ?? 'unknown';
  const userId = ctx?.from?.id ?? 'unknown';
  return `tg-${updateId}-${userId}`;
}

export function getDownloadFinalDeduplicationKey(correlationId) {
  const normalized = String(correlationId || '').trim();
  return normalized ? `download_final:${normalized}` : null;
}

export function claimDownloadRequest(ctx, url) {
  if (!ctx) return true;
  ctx.state ||= {};
  ctx.state.downloadClaims ||= new Set();
  const claim = normalizeUrlForClaim(url);
  if (ctx.state.downloadClaims.has(claim)) return false;
  ctx.state.downloadClaims.add(claim);
  return true;
}

export function logDownloadFlow(correlationId, stage, details = {}) {
  const safeDetails = {
    userId: details.userId,
    source: details.source,
    reason: details.reason,
    queued: details.queued
  };
  Object.keys(safeDetails).forEach((key) => safeDetails[key] === undefined && delete safeDetails[key]);
  console.log(`[DownloadFlow:${correlationId || 'unknown'}] ${stage}`, safeDetails);
}
