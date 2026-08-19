import { getActiveTariffCode, getEffectiveDownloadLimit } from './downloadLimitCore.js';
const LABELS={free:'Free',plus:'Plus',pro:'Pro',unlimited:'Unlimited'};
const CLASSES={free:'text-bg-secondary',plus:'text-bg-info',pro:'text-bg-warning',unlimited:'text-bg-primary'};
export function buildUserTariffPresentation(user,limits,now=new Date()) {
  const activeTariff=getActiveTariffCode(user,now);
  const premiumUntil=user?.premium_until?new Date(user.premium_until):null;
  const premiumActive=activeTariff!=='free';
  return {activeTariff,effectiveLimit:getEffectiveDownloadLimit(user,limits,now),premiumActive,unlimited:activeTariff==='unlimited',planName:LABELS[activeTariff],planClass:CLASSES[activeTariff],expiredPremium:Boolean(!premiumActive&&premiumUntil&&Number.isFinite(premiumUntil.getTime())&&(user?.premium_limit===null||Number(user?.premium_limit)>Number(limits.free)))};
}
