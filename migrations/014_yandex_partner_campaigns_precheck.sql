-- Read-only precheck for 014_yandex_partner_campaigns.sql.
-- Every check should return PASS before the main migration is applied.

SELECT 'required extensions/schema' AS check_name,
       CASE WHEN to_regnamespace('public') IS NOT NULL AND to_regnamespace('storage') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS result;

SELECT 'source campaign table exists' AS check_name,
       CASE WHEN to_regclass('public.ad_campaigns') IS NOT NULL OR to_regclass('public.promo_campaigns') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS result;

SELECT 'required tables exist' AS check_name,
       CASE WHEN to_regclass('public.users') IS NOT NULL
                  AND to_regclass('public.app_settings') IS NOT NULL
                  AND to_regclass('public.analytics_events') IS NOT NULL
                  AND to_regclass('storage.buckets') IS NOT NULL
            THEN 'PASS' ELSE 'FAIL' END AS result;

SELECT 'analytics contract exists' AS check_name,
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='analytics_events' AND column_name='deduplication_key')
                  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='analytics_events' AND column_name='event_data')
                  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='analytics_events' AND column_name='campaign_id')
            THEN 'PASS' ELSE 'FAIL' END AS result;

DO $$
DECLARE invalid_count bigint;
BEGIN
  IF to_regclass('public.ad_campaigns') IS NOT NULL
     AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='ad_campaigns' AND column_name='promo_key') THEN
    EXECUTE $sql$
      SELECT count(*) FROM (
        SELECT promo_key FROM public.ad_campaigns
        WHERE promo_key IS NOT NULL
        GROUP BY promo_key
        HAVING promo_key !~ '^[a-z0-9_]{1,40}$' OR count(*)>1
      ) invalid
    $sql$ INTO invalid_count;
    IF invalid_count>0 THEN RAISE EXCEPTION 'FAIL: % invalid or duplicate promo_key values',invalid_count; END IF;
  END IF;
  RAISE NOTICE 'PASS: existing campaign identity can be migrated';
END $$;

SELECT 'event campaign references are parseable' AS check_name,
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM public.analytics_events
         WHERE event_name IN ('yandex_promo_shown','yandex_promo_clicked')
           AND campaign_id IS NULL
           AND COALESCE(event_data->>'campaign_id','') !~ '^[0-9]+$'
       ) THEN 'PASS' ELSE 'WARN' END AS result;

SELECT 'orphan ad events' AS check_name, count(*) AS rows_to_review
FROM public.analytics_events e
WHERE e.event_name IN ('yandex_promo_shown','yandex_promo_clicked')
  AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id=e.user_id);

SELECT 'current ad event volume' AS check_name,
       count(*) FILTER (WHERE event_name='yandex_promo_shown') AS impressions,
       count(*) FILTER (WHERE event_name='yandex_promo_clicked') AS clicks
FROM public.analytics_events;

SELECT 'already applied' AS check_name,
       EXISTS(SELECT 1 FROM public.app_settings WHERE key='migration_014_yandex_partner_campaigns_applied') AS value;
