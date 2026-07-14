import crypto from 'node:crypto';

const LAUNCH_TOKEN_TTL_MS = 5 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function issueBroadcastLaunchToken(session, now = Date.now()) {
  if (!session) throw new Error('Authenticated session is required.');

  const token = crypto.randomBytes(32).toString('base64url');
  session.broadcastLaunchToken = {
    hash: hashToken(token),
    expiresAt: now + LAUNCH_TOKEN_TTL_MS
  };
  return token;
}

export function consumeBroadcastLaunchToken(session, token, now = Date.now()) {
  const stored = session?.broadcastLaunchToken;
  if (session) delete session.broadcastLaunchToken;

  if (!stored?.hash || !token || !Number.isFinite(stored.expiresAt) || stored.expiresAt < now) {
    return false;
  }

  const expected = Buffer.from(stored.hash, 'hex');
  const actual = Buffer.from(hashToken(token), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function assertBroadcastLaunchRequest({ action, launchTokenValid }) {
  if (action !== 'launch') {
    const error = new Error('Explicit action=launch is required.');
    error.code = 'BROADCAST_LAUNCH_INTENT_REQUIRED';
    throw error;
  }
  if (!launchTokenValid) {
    const error = new Error('A valid one-time launch token is required.');
    error.code = 'BROADCAST_LAUNCH_TOKEN_INVALID';
    throw error;
  }
}

export function validateBroadcastLaunchRequest(session, body, now = Date.now()) {
  const action = body?.action;
  const launchTokenValid = action === 'launch'
    ? consumeBroadcastLaunchToken(session, body?.launch_token, now)
    : false;
  assertBroadcastLaunchRequest({ action, launchTokenValid });
  return true;
}

export async function sendBroadcastPreview({
  bot,
  adminId,
  language,
  message,
  keyboard = [],
  fileId = null,
  fileMimeType = null,
  disableNotification = false,
  disableWebPagePreview = false,
  sendBatch
}) {
  if (!['ru', 'en'].includes(language)) {
    throw new Error('Preview language must be ru or en.');
  }
  if (!Number.isSafeInteger(Number(adminId)) || Number(adminId) === 0) {
    throw new Error('A valid ADMIN_ID is required for preview.');
  }
  if (typeof sendBatch !== 'function') {
    throw new Error('Preview sender is not configured.');
  }
  if (!message && !fileId) {
    throw new Error(`Preview ${language.toUpperCase()} has no message or media.`);
  }

  const recipients = [{ id: Number(adminId), first_name: 'Admin', delivered_language: language }];
  if (recipients.length !== 1) {
    throw new Error('Preview recipient count must equal 1.');
  }

  const task = {
    isTest: true,
    message: message || '',
    keyboard,
    file_id: fileId,
    file_mime_type: fileMimeType,
    disable_notification: Boolean(disableNotification),
    disable_web_page_preview: Boolean(disableWebPagePreview)
  };

  const results = await sendBatch(bot, task, recipients);
  if (!Array.isArray(results) || results.length !== 1 || results[0]?.status !== 'ok') {
    throw new Error('Preview delivery to the administrator failed.');
  }

  return { ok: true, language, recipientCount: 1 };
}
