SELECT to_regclass('public.subscription_activation_log') AS activation_log;
SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND ((table_name='users' AND column_name='daily_limit_override') OR (table_name='support_messages' AND column_name IN ('storage_path','mime_type','file_size')) OR (table_name='app_settings' AND column_name='updated_at')) ORDER BY column_name;
SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id='support-attachments';
SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN ('idx_subscription_activation_user_created','idx_support_messages_storage_path');
SELECT tariff_code, COUNT(*) FROM public.users GROUP BY tariff_code ORDER BY tariff_code;
