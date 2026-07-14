-- Align user_activity.user_id with users.id and Telegram BIGINT identifiers.
-- The original FK definition is read from PostgreSQL and restored verbatim,
-- preserving MATCH / ON UPDATE / ON DELETE / deferrability rules.

BEGIN;

DO $$
DECLARE
    v_column_type TEXT;
    v_constraint_def TEXT;
    v_user_activity_attnum SMALLINT;
    v_users_id_attnum SMALLINT;
    v_other_fk_count INTEGER;
BEGIN
    SELECT a.atttypid::regtype::text, a.attnum
      INTO v_column_type, v_user_activity_attnum
      FROM pg_attribute a
     WHERE a.attrelid = 'public.user_activity'::regclass
       AND a.attname = 'user_id'
       AND NOT a.attisdropped;

    IF v_column_type IS NULL THEN
        RAISE EXCEPTION 'Required column public.user_activity.user_id does not exist';
    END IF;

    SELECT a.attnum
      INTO v_users_id_attnum
      FROM pg_attribute a
     WHERE a.attrelid = 'public.users'::regclass
       AND a.attname = 'id'
       AND NOT a.attisdropped;

    SELECT pg_get_constraintdef(c.oid, true)
      INTO v_constraint_def
      FROM pg_constraint c
     WHERE c.conname = 'user_activity_user_id_fkey'
       AND c.contype = 'f'
       AND c.conrelid = 'public.user_activity'::regclass
       AND c.confrelid = 'public.users'::regclass
       AND c.conkey = ARRAY[v_user_activity_attnum]::smallint[]
       AND c.confkey = ARRAY[v_users_id_attnum]::smallint[];

    IF v_constraint_def IS NULL THEN
        RAISE EXCEPTION 'Expected FK user_activity_user_id_fkey (user_activity.user_id -> users.id) is missing or has an unexpected definition';
    END IF;

    SELECT COUNT(*)::integer
      INTO v_other_fk_count
      FROM pg_constraint c
     WHERE c.contype = 'f'
       AND c.conname <> 'user_activity_user_id_fkey'
       AND (
         (c.conrelid = 'public.user_activity'::regclass AND v_user_activity_attnum = ANY(c.conkey))
         OR
         (c.confrelid = 'public.user_activity'::regclass AND v_user_activity_attnum = ANY(c.confkey))
       );

    IF v_other_fk_count > 0 THEN
        RAISE EXCEPTION 'public.user_activity.user_id participates in % additional foreign key constraint(s); refusing unsafe type migration', v_other_fk_count;
    END IF;

    RAISE NOTICE 'Preserving FK definition: %', v_constraint_def;

    IF v_column_type = 'bigint' THEN
        RETURN;
    END IF;
    IF v_column_type <> 'integer' THEN
        RAISE EXCEPTION 'Expected public.user_activity.user_id to be integer or bigint, found %', v_column_type;
    END IF;

    ALTER TABLE public.user_activity
        DROP CONSTRAINT user_activity_user_id_fkey;

    ALTER TABLE public.user_activity
        ALTER COLUMN user_id TYPE BIGINT
        USING user_id::BIGINT;

    EXECUTE format(
        'ALTER TABLE public.user_activity ADD CONSTRAINT %I %s',
        'user_activity_user_id_fkey',
        v_constraint_def
    );
END $$;

INSERT INTO public.app_settings (key, value)
VALUES ('schema_version', '11')
ON CONFLICT (key) DO UPDATE
SET value = CASE
    WHEN public.app_settings.value ~ '^[0-9]+$'
        THEN GREATEST(public.app_settings.value::integer, EXCLUDED.value::integer)::text
    ELSE EXCLUDED.value
END;

COMMIT;
