-- Performance-only migration for Event Timeline, Retention Explorer and Source Analytics.
-- Execute each statement separately, outside an explicit transaction.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_analytics_events_user_created
    ON public.analytics_events (user_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_user_created
    ON public.payments (user_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_user_paid_completed
    ON public.payments (user_id, paid_at DESC)
    WHERE payment_status = 'completed' AND paid_at IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_broadcast_log_user_sent
    ON public.broadcast_log (user_id, sent_at DESC) WHERE status = 'sent';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_broadcast_clicks_user_clicked
    ON public.broadcast_clicks (user_id, clicked_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_downloads_log_user_downloaded
    ON public.downloads_log (user_id, downloaded_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_language_history_user_created
    ON public.language_history (user_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_actions_log_user_created
    ON public.user_actions_log (user_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_analytics_user_daily_user_day
    ON public.analytics_user_daily (user_id, day);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_created_at_id
    ON public.users (created_at DESC, id DESC);
