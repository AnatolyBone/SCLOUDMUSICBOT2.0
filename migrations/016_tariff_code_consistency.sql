BEGIN;
CREATE OR REPLACE FUNCTION public.sync_user_tariff_code() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.tariff_code:=CASE WHEN NEW.premium_until IS NULL OR NEW.premium_until<=NOW() THEN 'free' WHEN NEW.premium_limit IS NULL THEN 'unlimited' WHEN NEW.premium_limit>=100 THEN 'pro' ELSE 'plus' END;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_sync_user_tariff_code ON public.users;
CREATE TRIGGER trg_sync_user_tariff_code BEFORE INSERT OR UPDATE OF premium_limit,premium_until ON public.users FOR EACH ROW EXECUTE FUNCTION public.sync_user_tariff_code();
UPDATE public.users SET tariff_code=CASE WHEN premium_until IS NULL OR premium_until<=NOW() THEN 'free' WHEN premium_limit IS NULL THEN 'unlimited' WHEN premium_limit>=100 THEN 'pro' ELSE 'plus' END
WHERE tariff_code IS DISTINCT FROM CASE WHEN premium_until IS NULL OR premium_until<=NOW() THEN 'free' WHEN premium_limit IS NULL THEN 'unlimited' WHEN premium_limit>=100 THEN 'pro' ELSE 'plus' END;

DO $$ BEGIN
 IF to_regprocedure('public.process_stars_payment_legacy_016(bigint,uuid,character varying,character varying,bigint,character varying,text,character varying,bigint)') IS NULL THEN
  ALTER FUNCTION public.process_stars_payment(BIGINT,UUID,VARCHAR,VARCHAR,BIGINT,VARCHAR,TEXT,VARCHAR,BIGINT) RENAME TO process_stars_payment_legacy_016;
 END IF;
 IF to_regprocedure('public.process_manual_payment_legacy_016(bigint,bigint,character varying,bigint,character varying,character varying,integer,text)') IS NULL THEN
  ALTER FUNCTION public.process_manual_payment(BIGINT,BIGINT,VARCHAR,BIGINT,VARCHAR,VARCHAR,INTEGER,TEXT) RENAME TO process_manual_payment_legacy_016;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.process_stars_payment(BIGINT,UUID,VARCHAR,VARCHAR,BIGINT,VARCHAR,TEXT,VARCHAR,BIGINT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_result JSONB; v_plan TEXT;
BEGIN
 v_result:=public.process_stars_payment_legacy_016($1,$2,$3,$4,$5,$6,$7,$8,$9);
 v_plan:=v_result->>'plan';
 IF v_result->>'status' IN ('success','already_processed') AND v_plan IN ('plus','pro','unlim','unlimited') THEN
  UPDATE public.users SET tariff_code=CASE WHEN v_plan IN ('unlim','unlimited') THEN 'unlimited' ELSE v_plan END WHERE id=$1;
 END IF;
 RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.process_manual_payment(BIGINT,BIGINT,VARCHAR,BIGINT,VARCHAR,VARCHAR,INTEGER,TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_result JSONB; v_plan TEXT;
BEGIN
 v_result:=public.process_manual_payment_legacy_016($1,$2,$3,$4,$5,$6,$7,$8);
 v_plan:=v_result->>'plan';
 IF v_result->>'status'='success' AND v_plan IN ('plus','pro','unlim','unlimited') THEN
  UPDATE public.users SET tariff_code=CASE WHEN v_plan IN ('unlim','unlimited') THEN 'unlimited' ELSE v_plan END WHERE id=$2;
 END IF;
 RETURN v_result;
END $$;
COMMIT;
