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

COMMIT;
