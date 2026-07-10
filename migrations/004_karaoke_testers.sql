-- 1. Create table public.karaoke_testers (campaign tracking)
CREATE TABLE IF NOT EXISTS public.karaoke_testers (
    id SERIAL PRIMARY KEY,
    telegram_id BIGINT UNIQUE NOT NULL,
    username VARCHAR(100),
    first_name VARCHAR(100),
    source VARCHAR(50) DEFAULT 'music_bot',
    status VARCHAR(50) DEFAULT 'tester_active', -- tester_active, tester_waitlist, tester_expired
    plus_started_at TIMESTAMP WITH TIME ZONE,
    plus_until TIMESTAMP WITH TIME ZONE,
    invited_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    accepted_at TIMESTAMP WITH TIME ZONE,
    last_reminded_at TIMESTAMP WITH TIME ZONE,
    feedback_count INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index on telegram_id for fast queries
CREATE INDEX IF NOT EXISTS idx_karaoke_testers_telegram_id ON public.karaoke_testers(telegram_id);

-- Enable Row Level Security (RLS) to prevent public anonymous read/write access
ALTER TABLE public.karaoke_testers ENABLE ROW LEVEL SECURITY;

-- Allow administrators full access to the karaoke testers registry
DROP POLICY IF EXISTS "Admins can manage karaoke testers" ON public.karaoke_testers;
CREATE POLICY "Admins can manage karaoke testers"
ON public.karaoke_testers
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = auth.uid()
    AND profiles.role = 'admin'
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = auth.uid()
    AND profiles.role = 'admin'
  )
);

-- 2. Alter public.profiles table conditionally if it exists
-- 3. Create trigger on public.profiles conditionally if it exists
CREATE OR REPLACE FUNCTION public.sync_profile_plus_on_insert_trigger()
RETURNS TRIGGER AS $$
DECLARE
    v_status varchar;
    v_plus_until timestamp with time zone;
BEGIN
    -- Check if user is an active tester in karaoke_testers
    SELECT status, plus_until INTO v_status, v_plus_until
    FROM public.karaoke_testers
    WHERE telegram_id = NEW.telegram_id AND status = 'tester_active' AND plus_until > NOW();

    -- If active tester, apply pro role and plus plan
    IF v_status IS NOT NULL THEN
        NEW.role := 'pro';
        NEW.plan := 'plus';
        NEW.plus_until := v_plus_until;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'profiles') THEN
        -- Add columns
        ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS plan VARCHAR(20) DEFAULT 'free';
        ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS plus_until TIMESTAMP WITH TIME ZONE;

        -- Create trigger
        IF NOT EXISTS (SELECT FROM information_schema.triggers WHERE trigger_name = 'sync_profile_plus_on_insert') THEN
            CREATE TRIGGER sync_profile_plus_on_insert
                BEFORE INSERT ON public.profiles
                FOR EACH ROW
                EXECUTE FUNCTION public.sync_profile_plus_on_insert_trigger();
        END IF;
    END IF;
END $$;

-- 4. Create database function to grant tester access
CREATE OR REPLACE FUNCTION public.grant_karaoke_tester_access(
    p_telegram_id bigint,
    p_username text,
    p_first_name text,
    p_source text DEFAULT 'music_bot',
    p_duration_days int DEFAULT 30,
    p_limit int DEFAULT 50
) RETURNS jsonb AS $$
DECLARE
    v_tester_id int;
    v_status text;
    v_plus_until timestamp with time zone;
    v_count_active int;
BEGIN
    -- Check if user is already an active tester
    SELECT id, status, plus_until INTO v_tester_id, v_status, v_plus_until
    FROM public.karaoke_testers
    WHERE telegram_id = p_telegram_id;

    -- If active, return success with current stats
    IF v_tester_id IS NOT NULL AND v_status = 'tester_active' AND v_plus_until > now() THEN
        RETURN jsonb_build_object(
            'success', true,
            'status', 'already_active',
            'tester_id', v_tester_id,
            'plus_until', v_plus_until
        );
    END IF;

    -- Count active testers to enforce limit
    SELECT COUNT(*) INTO v_count_active
    FROM public.karaoke_testers
    WHERE status = 'tester_active' AND plus_until > now();

    -- If limit reached, register as waitlist
    IF v_count_active >= p_limit THEN
        IF v_tester_id IS NOT NULL THEN
            UPDATE public.karaoke_testers
            SET status = 'tester_waitlist',
                username = p_username,
                first_name = p_first_name,
                updated_at = now()
            WHERE id = v_tester_id;
        ELSE
            INSERT INTO public.karaoke_testers (
                telegram_id, username, first_name, source, status, created_at, updated_at
            ) VALUES (
                p_telegram_id, p_username, p_first_name, p_source, 'tester_waitlist', now(), now()
            ) RETURNING id INTO v_tester_id;
        END IF;

        RETURN jsonb_build_object(
            'success', false,
            'status', 'waitlist',
            'tester_id', v_tester_id,
            'message', 'Limit of active testers reached'
        );
    END IF;

    -- Otherwise, grant active tester status
    v_plus_until := now() + (p_duration_days || ' days')::interval;
    
    IF v_tester_id IS NOT NULL THEN
        UPDATE public.karaoke_testers
        SET status = 'tester_active',
            username = p_username,
            first_name = p_first_name,
            plus_started_at = now(),
            plus_until = v_plus_until,
            accepted_at = now(),
            updated_at = now()
        WHERE id = v_tester_id;
    ELSE
        INSERT INTO public.karaoke_testers (
            telegram_id, username, first_name, source, status,
            plus_started_at, plus_until, accepted_at, created_at, updated_at
        ) VALUES (
            p_telegram_id, p_username, p_first_name, p_source, 'tester_active',
            now(), v_plus_until, now(), now(), now()
        ) RETURNING id INTO v_tester_id;
    END IF;

    -- Update public.profiles if user profile already exists (dynamic query prevents compilation errors if table is not yet created)
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'profiles') THEN
        EXECUTE 'UPDATE public.profiles SET role = $1, plan = $2, plus_until = $3, updated_at = now() WHERE telegram_id = $4'
        USING 'pro', 'plus', v_plus_until, p_telegram_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'status', 'tester_active',
        'tester_id', v_tester_id,
        'plus_until', v_plus_until
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. Add columns to users table for feedback mode conditionally if table exists
DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') THEN
        ALTER TABLE public.users ADD COLUMN IF NOT EXISTS karaoke_feedback_mode BOOLEAN DEFAULT FALSE;
        ALTER TABLE public.users ADD COLUMN IF NOT EXISTS karaoke_feedback_started_at TIMESTAMP WITH TIME ZONE;
    END IF;
END $$;

-- 6. Create Supabase Storage Bucket for feedback attachments (if schema exists)
INSERT INTO storage.buckets (id, name, public)
VALUES ('karaoke-feedback', 'karaoke-feedback', true)
ON CONFLICT (id) DO NOTHING;
