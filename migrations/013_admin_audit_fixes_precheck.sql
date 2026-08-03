SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('users','app_settings','support_messages');
SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('users','app_settings','support_messages') ORDER BY table_name, ordinal_position;
SELECT key, value FROM public.app_settings WHERE key LIKE 'daily_limit_%' ORDER BY key;
SELECT COUNT(*) AS legacy_support_images FROM public.support_messages WHERE media_type='photo' AND file_id IS NOT NULL;
SELECT COUNT(*) AS duplicate_usernames FROM (SELECT LOWER(username) FROM public.users WHERE username IS NOT NULL GROUP BY LOWER(username) HAVING COUNT(*) > 1) duplicates;
