-- migrations/006_analytics_system.sql

-- 0. Очистка пустой некорректной таблицы payments, если она существовала ранее
DO $$
DECLARE
    v_count INTEGER;
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'payments') THEN
        EXECUTE 'SELECT COUNT(*)::int FROM public.payments' INTO v_count;
        IF v_count = 0 THEN
            DROP TABLE public.payments CASCADE;
        END IF;
    END IF;
END $$;

-- 1. Создание таблицы предварительных заказов платежей
CREATE TABLE IF NOT EXISTS public.payment_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL,
    plan VARCHAR(50) NOT NULL,
    amount_minor BIGINT NOT NULL, -- Stars (целые)
    currency VARCHAR(10) DEFAULT 'XTR',
    placement VARCHAR(50),
    campaign_id INTEGER,
    status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'paid', 'expired', 'cancelled'
    period_days INTEGER NOT NULL DEFAULT 30,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    paid_at TIMESTAMP WITH TIME ZONE
);

-- 2. Создание таблицы финансовых платежей
CREATE TABLE IF NOT EXISTS public.payments (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    plan VARCHAR(50) NOT NULL,
    amount_minor BIGINT NOT NULL, -- RUB в копейках, XTR в целых Stars
    currency VARCHAR(10) NOT NULL, -- 'RUB' или 'XTR'
    payment_method VARCHAR(50) NOT NULL, -- 'telegram_stars', 'tbank', 'sbp', 'boosty', 'other_manual'
    payment_status VARCHAR(50) NOT NULL DEFAULT 'pending',
    telegram_payment_charge_id VARCHAR(150) UNIQUE,
    provider_payment_charge_id VARCHAR(150),
    invoice_payload VARCHAR(250),
    is_recurring BOOLEAN DEFAULT FALSE,
    is_first_recurring BOOLEAN DEFAULT FALSE,
    subscription_expiration_date TIMESTAMP WITH TIME ZONE,
    period_days INTEGER NOT NULL DEFAULT 30,
    comment TEXT,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    paid_at TIMESTAMP WITH TIME ZONE NULL
);

-- 3. Создание таблицы истории изменений и нефинансовых операций подписок
CREATE TABLE IF NOT EXISTS public.subscription_operations (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    payment_id BIGINT REFERENCES public.payments(id) ON DELETE SET NULL,
    op_type VARCHAR(50) NOT NULL, -- 'activation', 'renewal', 'gift', 'adjustment', 'test_grant', 'expiration', 'cancellation', 'refund'
    previous_plan VARCHAR(50),
    new_plan VARCHAR(50),
    previous_limit INTEGER,
    new_limit INTEGER,
    previous_premium_until TIMESTAMP WITH TIME ZONE,
    new_premium_until TIMESTAMP WITH TIME ZONE,
    previous_is_unlimited BOOLEAN DEFAULT FALSE,
    new_is_unlimited BOOLEAN DEFAULT FALSE,
    performed_by_type VARCHAR(30) NOT NULL, -- 'admin', 'system', 'telegram_stars_rpc'
    performed_by_user_id BIGINT,
    comment TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Создание таблицы лога необработанных платежей
CREATE TABLE IF NOT EXISTS public.unprocessed_payments_log (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT,
    order_id UUID,
    telegram_payment_charge_id VARCHAR(150) UNIQUE,
    provider_payment_charge_id VARCHAR(150),
    amount_minor BIGINT,
    currency VARCHAR(10),
    error_message TEXT,
    status VARCHAR(50) DEFAULT 'unprocessed', -- 'unprocessed', 'resolved'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Создание таблицы событий аналитики
CREATE TABLE IF NOT EXISTS public.analytics_events (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT,
    event_name VARCHAR(100) NOT NULL,
    event_category VARCHAR(50),
    event_data JSONB,
    session_id VARCHAR(100),
    event_origin VARCHAR(20) DEFAULT 'live', -- 'live', 'historical', 'manual', 'system'
    acquisition_source VARCHAR(50),
    event_source VARCHAR(50),
    placement VARCHAR(50),
    campaign_id INTEGER,
    language_code VARCHAR(10),
    deduplication_key VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uidx_analytics_events_dedup 
ON public.analytics_events (deduplication_key) 
WHERE deduplication_key IS NOT NULL;

-- 6. Создание таблицы ежедневных агрегатов
CREATE TABLE IF NOT EXISTS public.analytics_daily (
    day DATE PRIMARY KEY,
    dau INTEGER DEFAULT 0,
    wau INTEGER DEFAULT 0,
    mau INTEGER DEFAULT 0,
    registrations INTEGER DEFAULT 0,
    downloads_total INTEGER DEFAULT 0,
    downloads_from_cache INTEGER DEFAULT 0,
    downloads_new INTEGER DEFAULT 0,
    limits_reached INTEGER DEFAULT 0,
    tariffs_shown INTEGER DEFAULT 0,
    tariffs_clicked INTEGER DEFAULT 0,
    payments_started INTEGER DEFAULT 0,
    payments_completed INTEGER DEFAULT 0,
    revenue_rub_minor BIGINT DEFAULT 0,
    revenue_xtr BIGINT DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    aggregation_version INTEGER DEFAULT 1
);

-- 7. Создание таблицы активности пользователей по дням
CREATE TABLE IF NOT EXISTS public.analytics_user_daily (
    day DATE,
    user_id BIGINT,
    downloads_count INTEGER DEFAULT 0,
    searches_count INTEGER DEFAULT 0,
    limits_reached_count INTEGER DEFAULT 0,
    primary_source VARCHAR(50),
    PRIMARY KEY (day, user_id)
);

-- 8. Индексы для оптимизации выборок аналитики
CREATE INDEX IF NOT EXISTS idx_analytics_events_name ON public.analytics_events(event_name);
CREATE INDEX IF NOT EXISTS idx_analytics_events_user ON public.analytics_events(user_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created ON public.analytics_events(created_at);
CREATE INDEX IF NOT EXISTS idx_payments_user ON public.payments(user_id);
CREATE INDEX IF NOT EXISTS idx_sub_ops_user ON public.subscription_operations(user_id);

-- =========================================================================
--   9. RPC-ФУНКЦИЯ ДЛЯ ЗАЧИСЛЕНИЯ ПЛАТЕЖЕЙ TELEGRAM STARS
-- =========================================================================
CREATE OR REPLACE FUNCTION public.process_stars_payment(
    p_user_id BIGINT,
    p_order_id UUID,
    p_telegram_payment_charge_id VARCHAR(150),
    p_provider_payment_charge_id VARCHAR(150),
    p_amount_minor BIGINT,
    p_currency VARCHAR(10),
    p_invoice_payload TEXT,
    p_confirmed_by_type VARCHAR(30),
    p_confirmed_by_user_id BIGINT
) RETURNS JSONB AS $$
DECLARE
    v_order RECORD;
    v_user RECORD;
    v_prev_premium_until TIMESTAMP WITH TIME ZONE;
    v_new_premium_until TIMESTAMP WITH TIME ZONE;
    v_plan_limit INTEGER;
    v_payment_id BIGINT;
    v_op_type VARCHAR(50);
    v_prev_plan VARCHAR(50);
    v_prev_is_unlim BOOLEAN;
BEGIN
    -- 1. Конкурентная дедупликация: транзакционная рекомендательная блокировка
    PERFORM pg_advisory_xact_lock(hashtext(p_telegram_payment_charge_id));

    -- Проверка на уже обработанный платеж
    SELECT id, subscription_expiration_date, plan INTO v_payment_id, v_new_premium_until, v_prev_plan 
    FROM public.payments 
    WHERE telegram_payment_charge_id = p_telegram_payment_charge_id;
    
    IF FOUND THEN
        RETURN jsonb_build_object('status', 'already_processed', 'new_premium_until', v_new_premium_until, 'plan', v_prev_plan);
    END IF;

    -- 2. Блокировка и жесткая верификация заказа в БД
    SELECT * INTO v_order FROM public.payment_orders WHERE id = p_order_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'order_not_found');
    END IF;
    
    -- Сверка всех параметров заказа
    IF v_order.user_id <> p_user_id THEN
        RETURN jsonb_build_object('status', 'validation_failed', 'reason', 'user_id_mismatch');
    END IF;
    IF v_order.amount_minor <> p_amount_minor THEN
        RETURN jsonb_build_object('status', 'validation_failed', 'reason', 'amount_mismatch');
    END IF;
    IF v_order.currency <> p_currency THEN
        RETURN jsonb_build_object('status', 'validation_failed', 'reason', 'currency_mismatch');
    END IF;
    IF p_currency <> 'XTR' THEN
        RETURN jsonb_build_object('status', 'validation_failed', 'reason', 'invalid_currency');
    END IF;
    IF p_invoice_payload <> p_order_id::text THEN
        RETURN jsonb_build_object('status', 'validation_failed', 'reason', 'payload_mismatch');
    END IF;
    IF v_order.expires_at <= timezone('utc', now()) THEN
        RETURN jsonb_build_object('status', 'validation_failed', 'reason', 'order_expired');
    END IF;
    IF v_order.status <> 'pending' THEN
        RETURN jsonb_build_object('status', 'order_already_processed', 'order_status', v_order.status);
    END IF;

    -- Валидация тарифа
    IF v_order.plan NOT IN ('plus', 'pro', 'unlim') THEN
        RETURN jsonb_build_object('status', 'validation_failed', 'reason', 'invalid_plan');
    END IF;

    -- 3. Блокировка пользователя
    SELECT * INTO v_user FROM public.users WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'user_not_found');
    END IF;

    -- Сохраняем состояние до изменения тарифа
    v_prev_premium_until := v_user.premium_until;
    v_prev_is_unlim := (v_user.premium_limit IS NULL AND v_prev_premium_until IS NOT NULL AND v_prev_premium_until > timezone('utc', now()));
    
    IF v_prev_premium_until IS NOT NULL AND v_prev_premium_until > timezone('utc', now()) THEN
        v_new_premium_until := v_prev_premium_until + (v_order.period_days || ' days')::interval;
        v_op_type := 'renewal';
        IF v_user.premium_limit = 30 THEN v_prev_plan := 'plus';
        ELSIF v_user.premium_limit = 100 THEN v_prev_plan := 'pro';
        ELSIF v_user.premium_limit IS NULL THEN v_prev_plan := 'unlim';
        ELSE v_prev_plan := 'free';
        END IF;
    ELSE
        v_new_premium_until := timezone('utc', now()) + (v_order.period_days || ' days')::interval;
        v_op_type := 'activation';
        v_prev_plan := 'free';
    END IF;

    -- Лимиты нового тарифа
    IF v_order.plan = 'plus' THEN
        v_plan_limit := 30;
    ELSIF v_order.plan = 'pro' THEN
        v_plan_limit := 100;
    ELSIF v_order.plan = 'unlim' THEN
        v_plan_limit := NULL; -- NULL = Безлимит
    END IF;

    -- 4. Запись финансовой транзакции в payments
    INSERT INTO public.payments (
        user_id, plan, amount_minor, currency, payment_method, payment_status,
        telegram_payment_charge_id, provider_payment_charge_id, invoice_payload,
        period_days, paid_at, subscription_expiration_date
    ) VALUES (
        p_user_id, v_order.plan, v_order.amount_minor, v_order.currency, 'telegram_stars', 'completed',
        p_telegram_payment_charge_id, p_provider_payment_charge_id, p_order_id::text,
        v_order.period_days, timezone('utc', now()), v_new_premium_until
    ) RETURNING id INTO v_payment_id;

    -- 5. Обновление лимитов и срока действия пользователя
    UPDATE public.users 
    SET premium_limit = v_plan_limit,
        premium_until = v_new_premium_until,
        notified_about_expiration = FALSE,
        notified_exp_3d = FALSE,
        notified_exp_1d = FALSE,
        notified_exp_0d = FALSE
    WHERE id = p_user_id;

    -- 6. Перевод статуса заказа в paid
    UPDATE public.payment_orders 
    SET status = 'paid', paid_at = timezone('utc', now()) 
    WHERE id = p_order_id;

    -- 7. Запись расширенной нефинансовой операции
    INSERT INTO public.subscription_operations (
        user_id, payment_id, op_type, 
        previous_plan, new_plan,
        previous_limit, new_limit,
        previous_premium_until, new_premium_until,
        previous_is_unlimited, new_is_unlimited,
        performed_by_type, performed_by_user_id
    ) VALUES (
        p_user_id, v_payment_id, v_op_type,
        v_prev_plan, v_order.plan,
        v_user.premium_limit, v_plan_limit,
        v_prev_premium_until, v_new_premium_until,
        v_prev_is_unlim, (v_plan_limit IS NULL),
        'telegram_stars_rpc', NULL -- Принудительно системный тип для Stars
    );

    -- 8. Событие аналитики 1: payment_completed (с обработкой ошибок вставки)
    BEGIN
        INSERT INTO public.analytics_events (
            user_id, event_name, event_category, event_data, session_id,
            acquisition_source, placement, campaign_id, language_code, deduplication_key
        ) VALUES (
            p_user_id, 'payment_completed', 'monetization',
            jsonb_build_object('plan', v_order.plan, 'amount_xtr', v_order.amount_minor, 'payment_method', 'telegram_stars', 'payment_id', v_payment_id),
            NULL, v_user.referral_source, v_order.placement, v_order.campaign_id, v_user.lang,
            'payment_completed:' || p_telegram_payment_charge_id
        );
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Analytics insert failed (payment_completed): %', SQLERRM;
    END;

    -- 9. Событие аналитики 2: активация/продление (с обработкой ошибок вставки)
    BEGIN
        INSERT INTO public.analytics_events (
            user_id, event_name, event_category, event_data, session_id,
            acquisition_source, placement, campaign_id, language_code, deduplication_key
        ) VALUES (
            p_user_id, 
            CASE WHEN v_op_type = 'renewal' THEN 'subscription_renewed' ELSE 'subscription_activated' END, 
            'monetization',
            jsonb_build_object('plan', v_order.plan, 'premium_until', v_new_premium_until),
            NULL, v_user.referral_source, v_order.placement, v_order.campaign_id, v_user.lang,
            'subscription_operation:' || p_telegram_payment_charge_id
        );
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Analytics insert failed (subscription_operation): %', SQLERRM;
    END;

    RETURN jsonb_build_object(
        'status', 'success',
        'payment_id', v_payment_id,
        'op_type', v_op_type,
        'new_premium_until', v_new_premium_until,
        'plan', v_order.plan
    );
END;
$$ LANGUAGE plpgsql;

-- =========================================================================
--   10. RPC-ФУНКЦИЯ ДЛЯ ЗАЧИСЛЕНИЯ РУЧНЫХ ПЛАТЕЖЕЙ (Т-Банк, СБП, Boosty и т.д.)
-- =========================================================================
CREATE OR REPLACE FUNCTION public.process_manual_payment(
    p_admin_id BIGINT,
    p_user_id BIGINT,
    p_plan VARCHAR(50),
    p_amount_minor BIGINT,
    p_currency VARCHAR(10),
    p_payment_method VARCHAR(50),
    p_period_days INTEGER,
    p_comment TEXT
) RETURNS JSONB AS $$
DECLARE
    v_user RECORD;
    v_prev_premium_until TIMESTAMP WITH TIME ZONE;
    v_new_premium_until TIMESTAMP WITH TIME ZONE;
    v_plan_limit INTEGER;
    v_payment_id BIGINT;
    v_op_type VARCHAR(50);
    v_prev_plan VARCHAR(50);
    v_prev_is_unlim BOOLEAN;
BEGIN
    -- 1. Валидация тарифа
    IF p_plan NOT IN ('plus', 'pro', 'unlim') THEN
        RETURN jsonb_build_object('status', 'validation_failed', 'reason', 'invalid_plan');
    END IF;

    -- 2. Валидация ручного платежного метода
    IF p_payment_method NOT IN ('tbank', 'sbp', 'boosty', 'other_manual') THEN
        RETURN jsonb_build_object('status', 'validation_failed', 'reason', 'invalid_payment_method');
    END IF;

    -- 3. Блокировка пользователя
    SELECT * INTO v_user FROM public.users WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'user_not_found');
    END IF;

    -- Сохраняем состояние до изменения тарифа
    v_prev_premium_until := v_user.premium_until;
    v_prev_is_unlim := (v_user.premium_limit IS NULL AND v_prev_premium_until IS NOT NULL AND v_prev_premium_until > timezone('utc', now()));
    
    IF v_prev_premium_until IS NOT NULL AND v_prev_premium_until > timezone('utc', now()) THEN
        v_new_premium_until := v_prev_premium_until + (p_period_days || ' days')::interval;
        v_op_type := 'renewal';
        IF v_user.premium_limit = 30 THEN v_prev_plan := 'plus';
        ELSIF v_user.premium_limit = 100 THEN v_prev_plan := 'pro';
        ELSIF v_user.premium_limit IS NULL THEN v_prev_plan := 'unlim';
        ELSE v_prev_plan := 'free';
        END IF;
    ELSE
        v_new_premium_until := timezone('utc', now()) + (p_period_days || ' days')::interval;
        v_op_type := 'activation';
        v_prev_plan := 'free';
    END IF;

    -- Лимиты нового тарифа
    IF p_plan = 'plus' THEN
        v_plan_limit := 30;
    ELSIF p_plan = 'pro' THEN
        v_plan_limit := 100;
    ELSIF p_plan = 'unlim' THEN
        v_plan_limit := NULL; -- NULL = Безлимит
    END IF;

    -- 4. Запись финансовой транзакции в payments
    INSERT INTO public.payments (
        user_id, plan, amount_minor, currency, payment_method, payment_status,
        period_days, paid_at, subscription_expiration_date, comment
    ) VALUES (
        p_user_id, p_plan, p_amount_minor, p_currency, p_payment_method, 'completed',
        p_period_days, timezone('utc', now()), v_new_premium_until, p_comment
    ) RETURNING id INTO v_payment_id;

    -- 5. Обновление лимитов и срока действия пользователя
    UPDATE public.users 
    SET premium_limit = v_plan_limit,
        premium_until = v_new_premium_until,
        notified_about_expiration = FALSE,
        notified_exp_3d = FALSE,
        notified_exp_1d = FALSE,
        notified_exp_0d = FALSE
    WHERE id = p_user_id;

    -- 6. Запись расширенной нефинансовой операции
    INSERT INTO public.subscription_operations (
        user_id, payment_id, op_type, 
        previous_plan, new_plan,
        previous_limit, new_limit,
        previous_premium_until, new_premium_until,
        previous_is_unlimited, new_is_unlimited,
        performed_by_type, performed_by_user_id,
        comment
    ) VALUES (
        p_user_id, v_payment_id, v_op_type,
        v_prev_plan, p_plan,
        v_user.premium_limit, v_plan_limit,
        v_prev_premium_until, v_new_premium_until,
        v_prev_is_unlim, (v_plan_limit IS NULL),
        'admin', p_admin_id,
        p_comment
    );

    -- 7. Событие аналитики 1: payment_completed (с обработкой ошибок вставки)
    BEGIN
        INSERT INTO public.analytics_events (
            user_id, event_name, event_category, event_data, session_id,
            acquisition_source, placement, campaign_id, language_code, deduplication_key
        ) VALUES (
            p_user_id, 'payment_completed', 'monetization',
            jsonb_build_object('plan', p_plan, 'amount_minor', p_amount_minor, 'payment_method', p_payment_method, 'payment_id', v_payment_id),
            NULL, v_user.referral_source, 'manual_admin', NULL, v_user.lang,
            'payment_completed:manual:' || v_payment_id
        );
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Analytics insert failed (manual payment_completed): %', SQLERRM;
    END;

    -- 8. Событие аналитики 2: активация/продление (с обработкой ошибок вставки)
    BEGIN
        INSERT INTO public.analytics_events (
            user_id, event_name, event_category, event_data, session_id,
            acquisition_source, placement, campaign_id, language_code, deduplication_key
        ) VALUES (
            p_user_id, 
            CASE WHEN v_op_type = 'renewal' THEN 'subscription_renewed' ELSE 'subscription_activated' END, 
            'monetization',
            jsonb_build_object('plan', p_plan, 'premium_until', v_new_premium_until),
            NULL, v_user.referral_source, 'manual_admin', NULL, v_user.lang,
            'subscription_operation:manual:' || v_payment_id
        );
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Analytics insert failed (manual subscription_operation): %', SQLERRM;
    END;

    RETURN jsonb_build_object(
        'status', 'success',
        'payment_id', v_payment_id,
        'op_type', v_op_type,
        'new_premium_until', v_new_premium_until,
        'plan', p_plan
    );
END;
$$ LANGUAGE plpgsql;

-- =========================================================================
--   11. НАСТРОЙКА БЕЗОПАСНОСТИ И ОГРАНИЧЕНИЙ RPC (ПОЛИТИКИ И RLS)
-- =========================================================================

-- Включение RLS для всех новых таблиц
ALTER TABLE public.payment_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_user_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unprocessed_payments_log ENABLE ROW LEVEL SECURITY;

-- Удаление публичных прав вызова на платежные RPC-функции
REVOKE EXECUTE ON FUNCTION public.process_stars_payment(BIGINT, UUID, VARCHAR, VARCHAR, BIGINT, VARCHAR, TEXT, VARCHAR, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.process_manual_payment(BIGINT, BIGINT, VARCHAR, BIGINT, VARCHAR, VARCHAR, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;

-- Доступ только служебной backend-роли (service_role)
GRANT EXECUTE ON FUNCTION public.process_stars_payment(BIGINT, UUID, VARCHAR, VARCHAR, BIGINT, VARCHAR, TEXT, VARCHAR, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.process_manual_payment(BIGINT, BIGINT, VARCHAR, BIGINT, VARCHAR, VARCHAR, INTEGER, TEXT) TO service_role;

-- 12. Самовосстановление колонок в таблице payments, если она существовала ранее
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'payments') THEN
        ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS user_id BIGINT;
        ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS plan VARCHAR(50);
        ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS amount_minor BIGINT;
        ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS currency VARCHAR(10);
        ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50);
        ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS payment_status VARCHAR(50) NOT NULL DEFAULT 'pending';
        ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS period_days INTEGER NOT NULL DEFAULT 30;
        ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS comment TEXT;
        ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS metadata JSONB;
        ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP WITH TIME ZONE NULL;
        ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS telegram_payment_charge_id VARCHAR(150);
        ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS provider_payment_charge_id VARCHAR(150);
        ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS invoice_payload VARCHAR(250);
        ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN DEFAULT FALSE;
        ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS is_first_recurring BOOLEAN DEFAULT FALSE;
        ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS subscription_expiration_date TIMESTAMP WITH TIME ZONE;
        
        -- Попытка добавить unique constraint на telegram_payment_charge_id, если его нет
        BEGIN
            ALTER TABLE public.payments ADD CONSTRAINT uq_telegram_payment_charge_id UNIQUE (telegram_payment_charge_id);
        EXCEPTION
            WHEN duplicate_table OR duplicate_object THEN
                -- Игнорируем, если ограничение уже существует
        END;
    END IF;
END $$;
