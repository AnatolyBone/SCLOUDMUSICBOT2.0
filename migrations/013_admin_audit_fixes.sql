BEGIN;
CREATE TABLE IF NOT EXISTS subscription_activation_log (
  id bigserial PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id), old_tariff text,
  result_tariff text NOT NULL, old_expires_at timestamptz, new_expires_at timestamptz,
  source text NOT NULL, transaction_id text NOT NULL UNIQUE, result text NOT NULL,
  error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscription_activation_user_created ON subscription_activation_log(user_id, created_at DESC);
ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_limit_override integer CHECK (daily_limit_override IS NULL OR daily_limit_override >= 0);
ALTER TABLE users ADD COLUMN IF NOT EXISTS tariff_code text CHECK (tariff_code IS NULL OR tariff_code IN ('free','plus','pro','unlimited'));
INSERT INTO app_settings(key, value) SELECT 'daily_limit_unlimited', COALESCE((SELECT value FROM app_settings WHERE key='daily_limit_unlim'),'10000') ON CONFLICT (key) DO NOTHING;
UPDATE users SET tariff_code = CASE
  WHEN premium_until IS NULL OR premium_until <= NOW() THEN 'free'
  WHEN premium_limit IS NULL OR premium_limit >= COALESCE((SELECT value::int FROM app_settings WHERE key='daily_limit_unlimited'),10000) THEN 'unlimited'
  WHEN premium_limit >= 100 THEN 'pro'
  ELSE 'plus'
END WHERE tariff_code IS NULL;
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS storage_path text;
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS mime_type text;
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS file_size bigint;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_support_messages_storage_path ON support_messages(storage_path) WHERE storage_path IS NOT NULL;
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('support-attachments', 'support-attachments', false, 10485760, ARRAY['image/png','image/jpeg','image/webp'])
ON CONFLICT (id) DO UPDATE SET public=false, file_size_limit=EXCLUDED.file_size_limit, allowed_mime_types=EXCLUDED.allowed_mime_types;
COMMIT;
