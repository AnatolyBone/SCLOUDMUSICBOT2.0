-- Compatibility rollback for application code before migration 014.
-- It preserves analytics, state, audit rows and Storage objects.
-- Take a backup and stop application traffic before running.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.ad_campaigns') IS NULL THEN
    RAISE EXCEPTION 'ad_campaigns is missing; migration 014 is not in the expected state';
  END IF;
  IF to_regclass('public.promo_campaigns') IS NOT NULL THEN
    RAISE EXCEPTION 'promo_campaigns already exists; refusing an ambiguous rollback';
  END IF;
END $$;

-- Prevent new deliveries while the previous application version is restored.
UPDATE public.ad_campaigns SET is_active=false WHERE deleted_at IS NULL;

DROP FUNCTION IF EXISTS public.record_ad_campaign_impression(integer,bigint,text,bigint,text,text,integer,boolean,text,text,text,text);
DROP FUNCTION IF EXISTS public.record_ad_campaign_click(integer,bigint,text,bigint,text,text);
DROP FUNCTION IF EXISTS public.get_ad_campaign_stats(timestamptz,timestamptz);
DROP FUNCTION IF EXISTS public.get_ad_campaign_creative_stats(timestamptz,timestamptz);
DROP FUNCTION IF EXISTS public.get_ad_campaign_trigger_stats(timestamptz,timestamptz);

ALTER TABLE public.ad_campaigns RENAME TO promo_campaigns;

DELETE FROM public.app_settings WHERE key='migration_014_yandex_partner_campaigns_applied';

COMMIT;

-- Deliberately retained for lossless rollback:
-- ad_campaign_user_state, ad_user_category_state, ad_campaign_audit_log,
-- analytics_events, ad-campaign-media bucket and all media objects.
