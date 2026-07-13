-- migrations/008_analytics_preflight_fixes.sql

-- Добавляем недостающие колонки в таблицу broadcast_clicks
ALTER TABLE public.broadcast_clicks ADD COLUMN IF NOT EXISTS user_agent TEXT NULL;
ALTER TABLE public.broadcast_clicks ADD COLUMN IF NOT EXISTS language_code VARCHAR(10) NULL;

-- Добавляем индексы для оптимизации
CREATE INDEX IF NOT EXISTS idx_broadcast_clicks_clicked_at ON public.broadcast_clicks (clicked_at);
