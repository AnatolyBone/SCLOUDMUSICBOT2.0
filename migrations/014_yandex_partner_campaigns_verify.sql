-- Read-only verification after 014_yandex_partner_campaigns.sql.
-- Returns every check in one result set for the Supabase SQL Editor.

DO $$
BEGIN
  IF to_regclass('public.ad_campaigns') IS NULL THEN
    RAISE EXCEPTION 'Migration 014 is not applied: public.ad_campaigns is missing. Run the corrected main migration before verify.';
  END IF;
END $$;

WITH checks AS (
  SELECT 1 AS sort_order, 'migration marker'::text AS check_name,
         CASE WHEN EXISTS(SELECT 1 FROM public.app_settings WHERE key='migration_014_yandex_partner_campaigns_applied') THEN 'PASS' ELSE 'FAIL' END::text AS result

  UNION ALL
  SELECT 2, 'campaign table',
         CASE WHEN to_regclass('public.ad_campaigns') IS NOT NULL AND to_regclass('public.promo_campaigns') IS NULL THEN 'PASS' ELSE 'FAIL' END

  UNION ALL
  SELECT 3, 'state and audit tables',
         CASE WHEN to_regclass('public.ad_campaign_user_state') IS NOT NULL
                    AND to_regclass('public.ad_user_category_state') IS NOT NULL
                    AND to_regclass('public.ad_campaign_audit_log') IS NOT NULL
              THEN 'PASS' ELSE 'FAIL' END

  UNION ALL
  SELECT 4, 'required RPCs',
         CASE WHEN to_regprocedure('public.record_ad_campaign_impression(integer,bigint,text,bigint,text,text,integer,boolean,text,text,text,text)') IS NOT NULL
                    AND to_regprocedure('public.record_ad_campaign_click(integer,bigint,text,bigint,text,text)') IS NOT NULL
                    AND to_regprocedure('public.get_ad_campaign_stats(timestamp with time zone,timestamp with time zone)') IS NOT NULL
                    AND to_regprocedure('public.get_ad_campaign_creative_stats(timestamp with time zone,timestamp with time zone)') IS NOT NULL
                    AND to_regprocedure('public.get_ad_campaign_trigger_stats(timestamp with time zone,timestamp with time zone)') IS NOT NULL
              THEN 'PASS' ELSE 'FAIL' END

  UNION ALL
  SELECT 5, 'private media bucket',
         CASE WHEN EXISTS(
           SELECT 1 FROM storage.buckets
           WHERE id='ad-campaign-media' AND public=false AND file_size_limit=20971520
             AND allowed_mime_types @> ARRAY['image/jpeg','image/png','image/webp','image/gif','video/mp4']::text[]
         ) THEN 'PASS' ELSE 'FAIL' END

  UNION ALL
  SELECT 6, 'campaign identity valid',
         CASE WHEN NOT EXISTS(SELECT 1 FROM public.ad_campaigns WHERE promo_key IS NULL OR promo_key !~ '^[a-z0-9_]{1,40}$')
                    AND NOT EXISTS(SELECT promo_key FROM public.ad_campaigns GROUP BY promo_key HAVING count(*)>1)
              THEN 'PASS' ELSE 'FAIL' END

  UNION ALL
  SELECT 7, 'state matches event history',
         CASE WHEN NOT EXISTS (
           WITH expected AS (
             SELECT (event_data->>'campaign_id')::integer campaign_id,user_id,
                    count(*) FILTER(WHERE event_name='yandex_promo_shown')::integer impressions,
                    count(*) FILTER(WHERE event_name='yandex_promo_clicked')::integer clicks
             FROM public.analytics_events
             WHERE event_name IN('yandex_promo_shown','yandex_promo_clicked')
               AND event_data->>'campaign_id' ~ '^[0-9]+$'
             GROUP BY 1,2
           )
           SELECT 1 FROM expected e
           LEFT JOIN public.ad_campaign_user_state s USING(campaign_id,user_id)
           WHERE s.campaign_id IS NULL OR s.impressions_count<>e.impressions OR s.clicks_count<>e.clicks
         ) THEN 'PASS' ELSE 'FAIL' END

  UNION ALL
  SELECT 8, 'indexes',
         CASE WHEN to_regclass('public.ux_ad_campaigns_promo_key') IS NOT NULL
                    AND to_regclass('public.idx_analytics_events_campaign_id_json') IS NOT NULL
                    AND to_regclass('public.idx_analytics_events_promo_key_json') IS NOT NULL
              THEN 'PASS' ELSE 'FAIL' END
)
SELECT check_name,result FROM checks ORDER BY sort_order;
