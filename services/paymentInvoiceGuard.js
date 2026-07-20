const recentRequests = new Map();

export const INVOICE_REQUEST_COOLDOWN_MS = 10_000;

function requestKey(userId, plan) {
  return `${String(userId)}:${String(plan)}`;
}

export function acquireInvoiceRequest(userId, plan, now = Date.now()) {
  const key = requestKey(userId, plan);
  const previous = recentRequests.get(key);
  if (Number.isFinite(previous?.requestedAt)
    && now - previous.requestedAt < INVOICE_REQUEST_COOLDOWN_MS) {
    return false;
  }
  if (previous?.timer) clearTimeout(previous.timer);
  const timer = setTimeout(() => {
    if (recentRequests.get(key)?.requestedAt === now) recentRequests.delete(key);
  }, INVOICE_REQUEST_COOLDOWN_MS);
  timer.unref?.();
  recentRequests.set(key, { requestedAt: now, timer });
  return true;
}

export function releaseInvoiceRequest(userId, plan) {
  const key = requestKey(userId, plan);
  const request = recentRequests.get(key);
  if (request?.timer) clearTimeout(request.timer);
  recentRequests.delete(key);
}

export function clearInvoiceRequestGuard() {
  for (const request of recentRequests.values()) {
    if (request?.timer) clearTimeout(request.timer);
  }
  recentRequests.clear();
}
