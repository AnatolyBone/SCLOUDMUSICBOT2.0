import { randomUUID } from 'crypto';
import redisService from './redisClient.js';

const fallbackSessions=new Map();
const SESSION_TTL_SECONDS=1800;
let redisDegradationLogged=false;

function logRedisDegradation(operation,error=null) {
  if(redisDegradationLogged)return;
  redisDegradationLogged=true;
  const reason=error?.message ? `: ${error.message}` : '';
  console.warn(`[Promo Session] Redis unavailable during ${operation}; using process-local session lock. Cross-instance one-promo-per-session protection is degraded${reason}`);
}

function fallbackSession(userId) {
  const now=Date.now();const current=fallbackSessions.get(userId);
  if(current&&current.expiresAt>now){current.expiresAt=now+SESSION_TTL_SECONDS*1000;return current.id;}
  const id=randomUUID();fallbackSessions.set(userId,{id,expiresAt:now+SESSION_TTL_SECONDS*1000});return id;
}

export async function getPromoSessionId(userId) {
  try {
    const client=await redisService.ensureConnection();
    if(client){const key=`session:${userId}`;let id=await client.get(key);if(!id)id=randomUUID();await client.set(key,id,{EX:SESSION_TTL_SECONDS});return id;}
    logRedisDegradation('session lookup');
  } catch (error) {logRedisDegradation('session lookup',error);}
  return fallbackSession(userId);
}

export async function claimPromoSession(userId,sessionId) {
  const key=`promo-session-shown:${userId}:${sessionId}`;
  try {const client=await redisService.ensureConnection();if(client)return (await client.set(key,'1',{NX:true,EX:SESSION_TTL_SECONDS}))==='OK';logRedisDegradation('session claim');} catch (error) {logRedisDegradation('session claim',error);}
  const current=fallbackSessions.get(`${key}:claim`);if(current&&current>Date.now())return false;fallbackSessions.set(`${key}:claim`,Date.now()+SESSION_TTL_SECONDS*1000);return true;
}

export async function releasePromoSession(userId,sessionId) {
  const key=`promo-session-shown:${userId}:${sessionId}`;
  try {const client=await redisService.ensureConnection();if(client){await client.del(key);return;}logRedisDegradation('session release');} catch (error) {logRedisDegradation('session release',error);}
  fallbackSessions.delete(`${key}:claim`);
}
