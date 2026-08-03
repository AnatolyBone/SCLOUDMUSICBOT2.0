export const PROMO_CATEGORIES = new Set(['yandex', 'internal', 'partner', 'custom']);
export const PROMO_KEY_PATTERN = /^[a-z0-9_]{1,40}$/;

export function normalizePromoKey(value, fallbackName = '') {
  const raw = String(value || fallbackName).trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!raw || !PROMO_KEY_PATTERN.test(raw)) throw new Error('promo_key может содержать только латинские буквы, цифры и _.');
  return raw;
}

export function isCampaignEligible(campaign, context, now = new Date()) {
  if (!campaign?.is_active || campaign.is_archived || campaign.deleted_at || Number(campaign.weight) <= 0 || !campaign.url || !campaign.message_text) return false;
  const nowMs = now.getTime();
  if (campaign.starts_at && new Date(campaign.starts_at).getTime() > nowMs) return false;
  if (campaign.ends_at && new Date(campaign.ends_at).getTime() < nowMs) return false;
  const stats = context.byCampaign?.[campaign.id] || { impressions: 0, lastShownAt: null };
  if (Number(stats.impressions) >= Number(campaign.max_impressions_per_user || 3)) return false;
  if (stats.nextEligibleAt && new Date(stats.nextEligibleAt).getTime() > nowMs) return false;
  if (!stats.nextEligibleAt&&stats.lastClickedAt&&nowMs-new Date(stats.lastClickedAt).getTime()<Number(campaign.cooldown_after_click_days??30)*86_400_000)return false;
  if (!stats.nextEligibleAt&&stats.lastShownAt&&nowMs-new Date(stats.lastShownAt).getTime()<Number(campaign.cooldown_days??7)*86_400_000)return false;
  const categoryState=context.byCategory?.[campaign.category];
  if(categoryState?.nextEligibleAt&&new Date(categoryState.nextEligibleAt).getTime()>nowMs)return false;
  if(!categoryState?.nextEligibleAt&&categoryState?.lastShownAt&&nowMs-new Date(categoryState.lastShownAt).getTime()<Number(campaign.global_category_cooldown_days??7)*86_400_000)return false;
  if(campaign.category==='yandex'&&context.lastYandexShownAt&&nowMs-new Date(context.lastYandexShownAt).getTime()<Number(context.globalYandexCooldownDays??campaign.global_category_cooldown_days??7)*86_400_000)return false;
  const triggerType=campaign.trigger_type||'download_count';
  if(triggerType==='manual')return false;
  const activityType=context.activityType||'download_success';
  const downloadReady=activityType==='download_success'&&Number(context.downloadCount||0)>=Number(campaign.trigger_download_count??campaign.trigger_downloads??0);
  const activityAnchor=campaign.starts_at||campaign.created_at;
  const firstActivityAt=activityAnchor?new Date(activityAnchor).getTime()+Number(campaign.cooldown_days??7)*86_400_000:Number.POSITIVE_INFINITY;
  const activityReady=activityType!=='manual'&&(stats.lastShownAt ? nowMs>=new Date(stats.lastShownAt).getTime()+Number(campaign.cooldown_days??7)*86_400_000 : nowMs>=firstActivityAt);
  if(triggerType==='download_count'&&!downloadReady)return false;
  if(triggerType==='activity_cooldown'&&!activityReady)return false;
  if(triggerType==='combined'&&!downloadReady&&!activityReady)return false;
  return true;
}

export function getCampaignTriggerReason(campaign,context,now=new Date()) {
  const activityType=context.activityType||'download_success';
  const downloadReady=activityType==='download_success'&&Number(context.downloadCount||0)>=Number(campaign.trigger_download_count??campaign.trigger_downloads??0);
  const stats=context.byCampaign?.[campaign.id]||{};
  const activityAnchor=campaign.starts_at||campaign.created_at;
  const firstActivityAt=activityAnchor?new Date(activityAnchor).getTime()+Number(campaign.cooldown_days??7)*86_400_000:Number.POSITIVE_INFINITY;
  const activityReady=stats.lastShownAt ? now.getTime()>=new Date(stats.lastShownAt).getTime()+Number(campaign.cooldown_days??7)*86_400_000 : now.getTime()>=firstActivityAt;
  if((campaign.trigger_type||'download_count')==='activity_cooldown')return 'activity_cooldown';
  if((campaign.trigger_type||'download_count')==='combined'&&!downloadReady&&activityReady)return 'activity_cooldown';
  return 'download_count';
}

export function selectWeightedCampaign(campaigns, context, { now = new Date(), random = Math.random } = {}) {
  const eligible = campaigns.filter(c => isCampaignEligible(c, context, now));
  const total = eligible.reduce((sum, c) => sum + Number(c.weight), 0);
  if (!total) return null;
  let cursor = random() * total;
  for (const campaign of eligible) { cursor -= Number(campaign.weight); if (cursor < 0) return {...campaign,selected_trigger_type:getCampaignTriggerReason(campaign,context,now)}; }
  return eligible.length ? {...eligible.at(-1),selected_trigger_type:getCampaignTriggerReason(eligible.at(-1),context,now)} : null;
}
