-- Emergency separation of broadcast preview from confirmed campaign launches.
-- Safe and idempotent: no column drops, renames, or user data rewrites.

ALTER TABLE public.broadcast_tasks
    ADD COLUMN IF NOT EXISTS launch_confirmed_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE public.broadcast_tasks
    ADD COLUMN IF NOT EXISTS launch_confirmed_by BIGINT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_broadcast_tasks_pending_confirmed'
          AND conrelid = 'public.broadcast_tasks'::regclass
    ) THEN
        ALTER TABLE public.broadcast_tasks
            ADD CONSTRAINT ck_broadcast_tasks_pending_confirmed
            CHECK (
                status <> 'pending'
                OR (launch_confirmed_at IS NOT NULL AND launch_confirmed_by IS NOT NULL)
            ) NOT VALID;
    END IF;
END $$;

-- Fail closed exactly once while upgrading to version 10. Re-running the
-- idempotent migration after the administrator enables broadcasts must not
-- silently turn the switch off again.
DO $$
DECLARE
    v_schema_version INTEGER := 0;
BEGIN
    SELECT CASE WHEN value ~ '^[0-9]+$' THEN value::integer ELSE 0 END
      INTO v_schema_version
      FROM public.app_settings
     WHERE key = 'schema_version';

    IF COALESCE(v_schema_version, 0) < 10 THEN
        INSERT INTO public.app_settings (key, value)
        VALUES ('broadcasts_enabled', 'false')
        ON CONFLICT (key) DO UPDATE SET value = 'false';
    END IF;
END $$;

INSERT INTO public.app_settings (key, value)
VALUES ('schema_version', '10')
ON CONFLICT (key) DO UPDATE
SET value = CASE
    WHEN public.app_settings.value ~ '^[0-9]+$'
        THEN GREATEST(public.app_settings.value::integer, EXCLUDED.value::integer)::text
    ELSE EXCLUDED.value
END;
