BEGIN;

INSERT INTO public.app_settings(key,value) VALUES('yandex_global_cooldown_days','7') ON CONFLICT(key) DO NOTHING;

DO $$
BEGIN
  IF to_regclass('public.ad_campaigns') IS NULL AND to_regclass('public.promo_campaigns') IS NOT NULL THEN
    ALTER TABLE public.promo_campaigns RENAME TO ad_campaigns;
  END IF;
END $$;

ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS promo_key text;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'custom';
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS weight integer NOT NULL DEFAULT 1;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS cooldown_days integer NOT NULL DEFAULT 7;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS max_impressions_per_user integer NOT NULL DEFAULT 3;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS starts_at timestamptz;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS ends_at timestamptz;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS media_type text CHECK(media_type IN('image','video'));
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS media_storage_path text;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS media_mime_type text;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS media_file_size bigint;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS media_file_name text;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS archived_by text;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS deleted_by text;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS trigger_type text NOT NULL DEFAULT 'download_count' CHECK(trigger_type IN('download_count','activity_cooldown','combined','manual'));
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS trigger_download_count integer;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS global_category_cooldown_days integer NOT NULL DEFAULT 7;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS cooldown_after_click_days integer NOT NULL DEFAULT 30;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS activity_cooldown boolean NOT NULL DEFAULT false;
ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
UPDATE public.ad_campaigns SET trigger_download_count=COALESCE(trigger_download_count,trigger_downloads,3),activity_cooldown=trigger_type IN('activity_cooldown','combined');
ALTER TABLE public.ad_campaigns ALTER COLUMN trigger_download_count SET DEFAULT 3;
ALTER TABLE public.ad_campaigns ALTER COLUMN trigger_download_count SET NOT NULL;
UPDATE public.ad_campaigns SET promo_key=CASE id WHEN 1 THEN 'balance300' WHEN 2 THEN 'music' ELSE 'campaign_'||id END WHERE promo_key IS NULL;
UPDATE public.ad_campaigns SET category='yandex',is_system=true,weight=CASE id WHEN 1 THEN 25 ELSE 0 END,is_active=CASE id WHEN 1 THEN is_active ELSE false END
WHERE id IN(1,2) AND NOT EXISTS (SELECT 1 FROM public.app_settings WHERE key='migration_014_yandex_partner_campaigns_applied');
ALTER TABLE public.ad_campaigns ALTER COLUMN promo_key SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_ad_campaigns_promo_key ON public.ad_campaigns(promo_key);
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ck_ad_campaigns_promo_key') THEN ALTER TABLE public.ad_campaigns ADD CONSTRAINT ck_ad_campaigns_promo_key CHECK(promo_key ~ '^[a-z0-9_]{1,40}$'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ck_ad_campaigns_category') THEN ALTER TABLE public.ad_campaigns ADD CONSTRAINT ck_ad_campaigns_category CHECK(category IN('yandex','internal','partner','custom')); END IF; END $$;

CREATE TABLE IF NOT EXISTS public.ad_campaign_user_state(
  campaign_id integer NOT NULL REFERENCES public.ad_campaigns(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  impressions_count integer NOT NULL DEFAULT 0 CHECK(impressions_count>=0),
  clicks_count integer NOT NULL DEFAULT 0 CHECK(clicks_count>=0),
  last_shown_at timestamptz,
  last_clicked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  next_eligible_at timestamptz,
  PRIMARY KEY(campaign_id,user_id)
);
CREATE TABLE IF NOT EXISTS public.ad_user_category_state(
 user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,category text NOT NULL,last_shown_at timestamptz,next_eligible_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,category)
);
ALTER TABLE public.ad_campaign_user_state ADD COLUMN IF NOT EXISTS next_eligible_at timestamptz;
UPDATE public.ad_campaigns SET trigger_type='combined',trigger_download_count=3,cooldown_days=14,global_category_cooldown_days=14,cooldown_after_click_days=30,max_impressions_per_user=3,activity_cooldown=true
WHERE promo_key='music' AND NOT EXISTS (SELECT 1 FROM public.app_settings WHERE key='migration_014_yandex_partner_campaigns_applied');
CREATE INDEX IF NOT EXISTS idx_ad_campaign_user_state_user ON public.ad_campaign_user_state(user_id,last_shown_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_media_storage_path ON public.ad_campaigns(media_storage_path) WHERE media_storage_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_lifecycle ON public.ad_campaigns(is_active,is_archived,deleted_at);
CREATE TABLE IF NOT EXISTS public.ad_campaign_audit_log(
 id bigserial PRIMARY KEY,campaign_id integer NOT NULL,promo_key text NOT NULL,action text NOT NULL,admin_id text NOT NULL,
 old_values jsonb,new_values jsonb,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ad_campaign_audit_campaign ON public.ad_campaign_audit_log(campaign_id,created_at DESC);
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('ad-campaign-media','ad-campaign-media',false,20971520,ARRAY['image/jpeg','image/png','image/webp','image/gif','video/mp4'])
ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=EXCLUDED.file_size_limit,allowed_mime_types=EXCLUDED.allowed_mime_types;

CREATE INDEX IF NOT EXISTS idx_analytics_events_event_name ON public.analytics_events(event_name);
CREATE INDEX IF NOT EXISTS idx_analytics_events_user_id ON public.analytics_events(user_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at ON public.analytics_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_campaign_id_json ON public.analytics_events((event_data->>'campaign_id'));
CREATE INDEX IF NOT EXISTS idx_analytics_events_promo_key_json ON public.analytics_events((event_data->>'promo_key'));

INSERT INTO public.ad_campaign_user_state(campaign_id,user_id,impressions_count,clicks_count,last_shown_at,last_clicked_at)
SELECT c.id,e.user_id,
 count(*) FILTER(WHERE e.event_name='yandex_promo_shown')::integer,
 count(*) FILTER(WHERE e.event_name='yandex_promo_clicked')::integer,
 max(e.created_at) FILTER(WHERE e.event_name='yandex_promo_shown'),
 max(e.created_at) FILTER(WHERE e.event_name='yandex_promo_clicked')
FROM public.analytics_events e
JOIN public.ad_campaigns c ON c.id=COALESCE(e.campaign_id,CASE WHEN e.event_data->>'campaign_id' ~ '^[0-9]+$' THEN(e.event_data->>'campaign_id')::integer END)
JOIN public.users u ON u.id=e.user_id
WHERE e.event_name IN('yandex_promo_shown','yandex_promo_clicked')
  AND NOT EXISTS (SELECT 1 FROM public.app_settings WHERE key='migration_014_yandex_partner_campaigns_applied')
GROUP BY c.id,e.user_id
ON CONFLICT(campaign_id,user_id) DO UPDATE SET impressions_count=EXCLUDED.impressions_count,clicks_count=EXCLUDED.clicks_count,last_shown_at=EXCLUDED.last_shown_at,last_clicked_at=EXCLUDED.last_clicked_at,updated_at=now();
UPDATE public.ad_campaign_user_state s SET next_eligible_at=GREATEST(COALESCE(s.last_shown_at+make_interval(days=>c.cooldown_days),'-infinity'::timestamptz),COALESCE(s.last_clicked_at+make_interval(days=>c.cooldown_after_click_days),'-infinity'::timestamptz)) FROM public.ad_campaigns c WHERE c.id=s.campaign_id AND(s.last_shown_at IS NOT NULL OR s.last_clicked_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM public.app_settings WHERE key='migration_014_yandex_partner_campaigns_applied');
INSERT INTO public.ad_user_category_state(user_id,category,last_shown_at,next_eligible_at)
SELECT e.user_id,c.category,max(e.created_at),max(e.created_at+make_interval(days=>c.global_category_cooldown_days)) FROM analytics_events e JOIN ad_campaigns c ON c.id=COALESCE(e.campaign_id,CASE WHEN e.event_data->>'campaign_id' ~ '^[0-9]+$' THEN(e.event_data->>'campaign_id')::integer END) WHERE e.event_name='yandex_promo_shown' AND NOT EXISTS (SELECT 1 FROM public.app_settings WHERE key='migration_014_yandex_partner_campaigns_applied') GROUP BY e.user_id,c.category
ON CONFLICT(user_id,category) DO UPDATE SET last_shown_at=EXCLUDED.last_shown_at,next_eligible_at=EXCLUDED.next_eligible_at,updated_at=now();

CREATE OR REPLACE FUNCTION public.record_ad_campaign_impression(
  p_campaign_id integer,p_user_id bigint,p_promo_key text,p_message_id bigint,p_placement text,p_url_hash text,p_trigger_download_count integer,p_has_media boolean,p_media_type text,p_creative_variant text,p_trigger_type text,p_user_session_id text
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_number integer; v_event_id bigint; v_campaign_name text; v_last_shown timestamptz; v_cooldown integer; v_category text; v_category_cooldown integer;
BEGIN
  SELECT name,cooldown_days,category,global_category_cooldown_days INTO v_campaign_name,v_cooldown,v_category,v_category_cooldown FROM public.ad_campaigns WHERE id=p_campaign_id;
  INSERT INTO public.ad_campaign_user_state(campaign_id,user_id) VALUES(p_campaign_id,p_user_id) ON CONFLICT DO NOTHING;
  SELECT impressions_count+1,last_shown_at INTO v_number,v_last_shown FROM public.ad_campaign_user_state WHERE campaign_id=p_campaign_id AND user_id=p_user_id FOR UPDATE;
  INSERT INTO public.analytics_events(user_id,event_name,event_category,event_data,event_origin,event_source,placement,campaign_id,deduplication_key)
  VALUES(p_user_id,'yandex_promo_shown','promo',jsonb_build_object('campaign_id',p_campaign_id,'promo_key',p_promo_key,'campaign_name_snapshot',v_campaign_name,'message_id',p_message_id,'placement',p_placement,'url_hash',p_url_hash,'trigger_download_count',p_trigger_download_count,'impression_number',v_number,'has_media',p_has_media,'media_type',p_media_type,'creative_variant',p_creative_variant,'trigger_type',p_trigger_type,'days_since_previous_impression',CASE WHEN v_last_shown IS NULL THEN NULL ELSE floor(extract(epoch FROM(now()-v_last_shown))/86400) END,'user_session_id',p_user_session_id),'live','direct',p_placement,p_campaign_id,format('yandex_promo_shown:%s:%s:%s',p_campaign_id,p_user_id,p_message_id))
  ON CONFLICT(deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING RETURNING id INTO v_event_id;
  IF v_event_id IS NULL THEN RETURN NULL; END IF;
  UPDATE public.ad_campaign_user_state SET impressions_count=v_number,last_shown_at=now(),next_eligible_at=now()+make_interval(days=>v_cooldown),updated_at=now() WHERE campaign_id=p_campaign_id AND user_id=p_user_id;
  INSERT INTO public.ad_user_category_state(user_id,category,last_shown_at,next_eligible_at) VALUES(p_user_id,v_category,now(),now()+make_interval(days=>v_category_cooldown)) ON CONFLICT(user_id,category) DO UPDATE SET last_shown_at=EXCLUDED.last_shown_at,next_eligible_at=EXCLUDED.next_eligible_at,updated_at=now();
  RETURN v_number;
END $$;

CREATE OR REPLACE FUNCTION public.record_ad_campaign_click(
  p_campaign_id integer,p_user_id bigint,p_promo_key text,p_message_id bigint,p_placement text,p_url_hash text
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_event_id bigint; v_impression_number integer; v_trigger_download_count integer; v_campaign_name text; v_click_cooldown integer; v_trigger_type text; v_user_session_id text;
BEGIN
  SELECT name,cooldown_after_click_days INTO v_campaign_name,v_click_cooldown FROM public.ad_campaigns WHERE id=p_campaign_id;
  SELECT (event_data->>'impression_number')::integer,(event_data->>'trigger_download_count')::integer,event_data->>'trigger_type',event_data->>'user_session_id' INTO v_impression_number,v_trigger_download_count,v_trigger_type,v_user_session_id FROM public.analytics_events WHERE user_id=p_user_id AND event_name='yandex_promo_shown' AND event_data->>'campaign_id'=p_campaign_id::text AND event_data->>'message_id'=p_message_id::text LIMIT 1;
  IF v_impression_number IS NULL THEN RETURN false; END IF;
  INSERT INTO public.analytics_events(user_id,event_name,event_category,event_data,event_origin,event_source,placement,campaign_id,deduplication_key)
  VALUES(p_user_id,'yandex_promo_clicked','promo',jsonb_build_object('campaign_id',p_campaign_id,'promo_key',p_promo_key,'campaign_name_snapshot',v_campaign_name,'message_id',p_message_id,'placement',p_placement,'url_hash',p_url_hash,'trigger_download_count',v_trigger_download_count,'impression_number',v_impression_number,'trigger_type',v_trigger_type,'user_session_id',v_user_session_id),'live','callback_query',p_placement,p_campaign_id,format('yandex_promo_clicked:%s:%s:%s',p_campaign_id,p_user_id,p_message_id))
  ON CONFLICT(deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING RETURNING id INTO v_event_id;
  IF v_event_id IS NULL THEN RETURN false; END IF;
  UPDATE public.ad_campaign_user_state SET clicks_count=clicks_count+1,last_clicked_at=now(),next_eligible_at=GREATEST(COALESCE(next_eligible_at,now()),now()+make_interval(days=>v_click_cooldown)),updated_at=now() WHERE campaign_id=p_campaign_id AND user_id=p_user_id;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.get_ad_campaign_stats(p_from timestamptz DEFAULT NULL,p_to timestamptz DEFAULT NULL)
RETURNS TABLE(campaign_id integer,impressions bigint,unique_impressions bigint,clicks bigint,unique_clicks bigint,ctr numeric,repeat_impressions bigint,average_impressions_per_user numeric,last_shown_at timestamptz,last_clicked_at timestamptz)
LANGUAGE sql STABLE AS $$
WITH filtered AS(
 SELECT user_id,event_name,created_at,(event_data->>'campaign_id')::integer campaign_id
 FROM public.analytics_events
 WHERE event_name IN('yandex_promo_shown','yandex_promo_clicked') AND event_data ? 'campaign_id'
   AND(p_from IS NULL OR created_at>=p_from) AND(p_to IS NULL OR created_at<p_to)
), per_user AS(
 SELECT campaign_id,user_id,count(*) FILTER(WHERE event_name='yandex_promo_shown') shown,count(*) FILTER(WHERE event_name='yandex_promo_clicked') clicked,max(created_at) FILTER(WHERE event_name='yandex_promo_shown') last_show,max(created_at) FILTER(WHERE event_name='yandex_promo_clicked') last_click
 FROM filtered GROUP BY campaign_id,user_id
)
SELECT campaign_id,sum(shown)::bigint,count(*) FILTER(WHERE shown>0)::bigint,sum(clicked)::bigint,count(*) FILTER(WHERE clicked>0)::bigint,
 round(100.0*count(*) FILTER(WHERE clicked>0)/NULLIF(count(*) FILTER(WHERE shown>0),0),2),count(*) FILTER(WHERE shown>1)::bigint,
 round(sum(shown)::numeric/NULLIF(count(*) FILTER(WHERE shown>0),0),2),max(last_show),max(last_click)
FROM per_user GROUP BY campaign_id;
$$;

CREATE OR REPLACE FUNCTION public.get_ad_campaign_creative_stats(p_from timestamptz DEFAULT NULL,p_to timestamptz DEFAULT NULL)
RETURNS TABLE(has_media boolean,creative_variant text,impressions bigint,unique_impressions bigint,clicks bigint,unique_clicks bigint,ctr numeric)
LANGUAGE sql STABLE AS $$
WITH events AS(
 SELECT user_id,event_name,COALESCE((event_data->>'has_media')::boolean,false) has_media,COALESCE(event_data->>'creative_variant','legacy') creative_variant
 FROM public.analytics_events WHERE event_name IN('yandex_promo_shown','yandex_promo_clicked') AND(p_from IS NULL OR created_at>=p_from) AND(p_to IS NULL OR created_at<p_to)
)
SELECT has_media,creative_variant,count(*) FILTER(WHERE event_name='yandex_promo_shown'),count(DISTINCT user_id) FILTER(WHERE event_name='yandex_promo_shown'),count(*) FILTER(WHERE event_name='yandex_promo_clicked'),count(DISTINCT user_id) FILTER(WHERE event_name='yandex_promo_clicked'),round(100.0*count(DISTINCT user_id) FILTER(WHERE event_name='yandex_promo_clicked')/NULLIF(count(DISTINCT user_id) FILTER(WHERE event_name='yandex_promo_shown'),0),2)
FROM events GROUP BY has_media,creative_variant;
$$;

CREATE OR REPLACE FUNCTION public.get_ad_campaign_trigger_stats(p_from timestamptz DEFAULT NULL,p_to timestamptz DEFAULT NULL)
RETURNS TABLE(trigger_type text,impressions bigint,unique_impressions bigint,clicks bigint,unique_clicks bigint,ctr numeric)
LANGUAGE sql STABLE AS $$
WITH events AS(SELECT user_id,event_name,COALESCE(event_data->>'trigger_type','legacy') trigger_type FROM analytics_events WHERE event_name IN('yandex_promo_shown','yandex_promo_clicked') AND(p_from IS NULL OR created_at>=p_from) AND(p_to IS NULL OR created_at<p_to))
SELECT trigger_type,count(*) FILTER(WHERE event_name='yandex_promo_shown'),count(DISTINCT user_id) FILTER(WHERE event_name='yandex_promo_shown'),count(*) FILTER(WHERE event_name='yandex_promo_clicked'),count(DISTINCT user_id) FILTER(WHERE event_name='yandex_promo_clicked'),round(100.0*count(DISTINCT user_id) FILTER(WHERE event_name='yandex_promo_clicked')/NULLIF(count(DISTINCT user_id) FILTER(WHERE event_name='yandex_promo_shown'),0),2) FROM events GROUP BY trigger_type;
$$;

INSERT INTO public.ad_campaigns(name,promo_key,trigger_downloads,trigger_type,trigger_download_count,global_category_cooldown_days,cooldown_after_click_days,activity_cooldown,message_text,button_text,url,is_active,category,weight,cooldown_days,max_impressions_per_user,is_system)
VALUES
('Яндекс — задания и награды','rewards_landing',3,'download_count',3,7,30,false,E'🎁 <b>Получи бонус от Яндекса</b>\n\nВыбери доступное задание, выполни условия и получи награду на баланс телефона.\n\nПредложения и размер бонуса зависят от доступных заданий.','🎁 Посмотреть задания','',false,'yandex',50,7,3,true),
('Яндекс с Алисой AI','alice_app',3,'download_count',3,7,30,false,E'🤖 <b>Попробуй Яндекс с Алисой AI</b>\n\nПоиск, Алиса и полезные сервисы Яндекса в одном приложении.\n\nУстанови приложение по специальной ссылке.','🤖 Установить Яндекс','',false,'yandex',25,7,3,true)
ON CONFLICT(promo_key) DO NOTHING;

INSERT INTO public.app_settings(key,value)
VALUES('migration_014_yandex_partner_campaigns_applied',now()::text)
ON CONFLICT(key) DO NOTHING;

COMMIT;
