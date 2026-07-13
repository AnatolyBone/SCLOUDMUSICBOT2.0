-- Reconcile the application schema contract without renaming production columns.
-- This migration is intentionally idempotent and safe to run after partial 006/007/008 installs.

CREATE TABLE IF NOT EXISTS public.app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS public.broadcast_tasks (
    id BIGSERIAL PRIMARY KEY,
    message TEXT,
    file_id TEXT,
    target_audience VARCHAR(50) NOT NULL DEFAULT 'all',
    disable_notification BOOLEAN NOT NULL DEFAULT FALSE,
    scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    status VARCHAR(30) NOT NULL DEFAULT 'pending',
    report JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    keyboard JSONB,
    disable_web_page_preview BOOLEAN NOT NULL DEFAULT FALSE,
    file_mime_type VARCHAR(150),
    started_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS public.broadcast_log (
    id BIGSERIAL PRIMARY KEY,
    broadcast_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    sent_at TIMESTAMP WITH TIME ZONE,
    audience_language_segment VARCHAR(10),
    delivered_language VARCHAR(10),
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
);

ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS message TEXT;
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS file_id TEXT;
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS target_audience VARCHAR(50) DEFAULT 'all';
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS disable_notification BOOLEAN DEFAULT FALSE;
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'pending';
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS report JSONB;
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS keyboard JSONB;
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS disable_web_page_preview BOOLEAN DEFAULT FALSE;
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS file_mime_type VARCHAR(150);
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS started_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE public.broadcast_log ADD COLUMN IF NOT EXISTS sent_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.broadcast_log ADD COLUMN IF NOT EXISTS audience_language_segment VARCHAR(10);
ALTER TABLE public.broadcast_log ADD COLUMN IF NOT EXISTS delivered_language VARCHAR(10);
ALTER TABLE public.broadcast_log ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending';

ALTER TABLE public.broadcast_clicks ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE public.broadcast_clicks ADD COLUMN IF NOT EXISTS language_code VARCHAR(10);

ALTER TABLE public.language_history ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS target_languages TEXT[] NOT NULL DEFAULT ARRAY['all'];
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS unknown_language_policy VARCHAR(20) NOT NULL DEFAULT 'use_ru';
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS messages_json JSONB;
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS language_source_filter VARCHAR(30) NOT NULL DEFAULT 'all';
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS message_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS broadcast_type VARCHAR(30) DEFAULT 'marketing';
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS campaign_tag VARCHAR(100);
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS campaign_name VARCHAR(100);
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS fallback_language VARCHAR(10) DEFAULT 'ru';

ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS telegram_payment_charge_id VARCHAR(150);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS provider_payment_charge_id VARCHAR(150);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS invoice_payload VARCHAR(250);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN DEFAULT FALSE;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS is_first_recurring BOOLEAN DEFAULT FALSE;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS subscription_expiration_date TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS period_days INTEGER DEFAULT 30;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS comment TEXT;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS metadata JSONB;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE public.analytics_daily ADD COLUMN IF NOT EXISTS downloads_from_cache INTEGER DEFAULT 0;
ALTER TABLE public.analytics_daily ADD COLUMN IF NOT EXISTS downloads_new INTEGER DEFAULT 0;
ALTER TABLE public.analytics_daily ADD COLUMN IF NOT EXISTS tariffs_shown INTEGER DEFAULT 0;
ALTER TABLE public.analytics_daily ADD COLUMN IF NOT EXISTS tariffs_clicked INTEGER DEFAULT 0;
ALTER TABLE public.analytics_daily ADD COLUMN IF NOT EXISTS payments_started INTEGER DEFAULT 0;
ALTER TABLE public.analytics_daily ADD COLUMN IF NOT EXISTS payments_completed INTEGER DEFAULT 0;
ALTER TABLE public.analytics_daily ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE public.analytics_daily ADD COLUMN IF NOT EXISTS aggregation_version INTEGER DEFAULT 1;

ALTER TABLE public.analytics_user_daily ADD COLUMN IF NOT EXISTS primary_source VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_broadcast_clicks_clicked_at
    ON public.broadcast_clicks (clicked_at);
CREATE INDEX IF NOT EXISTS idx_broadcast_clicks_campaign_id
    ON public.broadcast_clicks (campaign_id);
CREATE INDEX IF NOT EXISTS idx_language_history_user_time
    ON public.language_history (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_broadcast_log_broadcast_user
    ON public.broadcast_log (broadcast_id, user_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_log_id_status
    ON public.broadcast_log (broadcast_id, status);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_schema = 'public'
          AND table_name = 'broadcast_clicks'
          AND constraint_name = 'fk_broadcast_clicks_campaign'
    ) THEN
        ALTER TABLE public.broadcast_clicks
            ADD CONSTRAINT fk_broadcast_clicks_campaign
            FOREIGN KEY (campaign_id) REFERENCES public.broadcast_tasks(id) ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_schema = 'public'
          AND table_name = 'broadcast_clicks'
          AND constraint_name = 'fk_broadcast_clicks_user'
    ) THEN
        ALTER TABLE public.broadcast_clicks
            ADD CONSTRAINT fk_broadcast_clicks_user
            FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    END IF;
END $$;
