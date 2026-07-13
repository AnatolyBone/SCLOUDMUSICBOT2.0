-- migrations/007_multilang_system.sql

-- 1. Таблица кликов по рассылкам
CREATE TABLE IF NOT EXISTS public.broadcast_clicks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    button_index INTEGER NOT NULL,
    user_agent TEXT NULL,
    language_code VARCHAR(10) NULL,
    clicked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Таблица истории смены языков
CREATE TABLE IF NOT EXISTS public.language_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL,
    previous_language VARCHAR(10) NULL,
    new_language VARCHAR(10) NOT NULL,
    previous_source VARCHAR(30) NULL,
    new_source VARCHAR(30) NOT NULL,
    changed_by_type VARCHAR(20) NOT NULL,
    changed_by_user_id BIGINT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Добавление колонок в таблицу users для хранения языка
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS telegram_language_code VARCHAR(20) NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS language_code VARCHAR(10) NOT NULL DEFAULT 'ru';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS language_source VARCHAR(30) NOT NULL DEFAULT 'legacy_default';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS language_updated_at TIMESTAMP WITH TIME ZONE NULL;

-- Индексы по языковому коду и источнику
CREATE INDEX IF NOT EXISTS idx_users_language_code ON public.users (language_code);
CREATE INDEX IF NOT EXISTS idx_users_language_source_code ON public.users (language_source, language_code);

-- Миграция существующих пользователей (проставляем legacy_default)
UPDATE public.users 
SET language_code = 'ru',
    language_source = 'legacy_default'
WHERE language_source IS NULL OR language_source = 'default';

-- 4. Внешние ключи и индексы для таблицы кликов и лога
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_broadcast_clicks_campaign') THEN
        ALTER TABLE public.broadcast_clicks ADD CONSTRAINT fk_broadcast_clicks_campaign FOREIGN KEY (campaign_id) REFERENCES public.broadcast_tasks(id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_broadcast_clicks_user') THEN
        ALTER TABLE public.broadcast_clicks ADD CONSTRAINT fk_broadcast_clicks_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_broadcast_clicks_campaign_id ON public.broadcast_clicks (campaign_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_clicks_campaign_user ON public.broadcast_clicks (campaign_id, user_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_clicks_campaign_button ON public.broadcast_clicks (campaign_id, button_index);
CREATE INDEX IF NOT EXISTS idx_language_history_user_time ON public.language_history (user_id, created_at DESC);

-- 5. Лог рассылки и уникальный индекс для snapshot
ALTER TABLE public.broadcast_log ADD COLUMN IF NOT EXISTS audience_language_segment VARCHAR(10) NULL;
ALTER TABLE public.broadcast_log ADD COLUMN IF NOT EXISTS delivered_language VARCHAR(10) NULL;
ALTER TABLE public.broadcast_log ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS ux_broadcast_log_broadcast_user ON public.broadcast_log (broadcast_id, user_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_log_id_status ON public.broadcast_log (broadcast_id, status);

-- 6. Модификация bot_texts (безопасное уникальное ограничение)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'bot_texts' AND column_name = 'language_code') THEN
        ALTER TABLE public.bot_texts ADD COLUMN language_code VARCHAR(10) NOT NULL DEFAULT 'ru';
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_bot_texts_key_language ON public.bot_texts (key, language_code);

-- 7. Модификация broadcast_tasks для хранения мультиязычных сообщений
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS target_languages TEXT[] NOT NULL DEFAULT ARRAY['all'];
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS unknown_language_policy VARCHAR(20) NOT NULL DEFAULT 'use_ru';
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS messages_json JSONB NULL;
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS language_source_filter VARCHAR(30) NOT NULL DEFAULT 'all';
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS message_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS broadcast_type VARCHAR(30) DEFAULT 'marketing';
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS campaign_name VARCHAR(100) NULL;
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS campaign_tag VARCHAR(100) NULL;
ALTER TABLE public.broadcast_tasks ADD COLUMN IF NOT EXISTS fallback_language VARCHAR(10) DEFAULT 'ru';
