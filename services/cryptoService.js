// services/cryptoService.js
import crypto from 'crypto';
import { CONFIG } from '../config.js';

const SECRET = process.env.REDIRECT_SECRET || process.env.SESSION_SECRET || process.env.BOT_TOKEN;
const encryptionSecret = SECRET || 'dev-secret-key-do-not-use-in-production';

/**
 * Создает подписанный токен перенаправления (HMAC-SHA256)
 */
export function createRedirectToken(campaignId, userId, buttonIndex, destUrl = null) {
  const payload = {
    c: campaignId,
    u: userId,
    b: buttonIndex,
    exp: Math.floor(Date.now() / 1000) + (14 * 24 * 3600) // 14 дней срок действия
  };
  if (destUrl) {
    payload.url = destUrl;
  }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', encryptionSecret)
    .update(body)
    .digest('base64url');
  return `${body}.${signature}`;
}

/**
 * Проверяет подпись и срок действия токена перенаправления
 */
export function verifyRedirectToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [body, signature] = parts;
    
    const expectedSig = crypto.createHmac('sha256', encryptionSecret)
      .update(body)
      .digest('base64url');
      
    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSig);
    
    if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      return null;
    }
    
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp * 1000) {
      return null; // Токен просрочен
    }
    return payload;
  } catch (e) {
    return null;
  }
}
