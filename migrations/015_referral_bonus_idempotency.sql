BEGIN;
CREATE TABLE IF NOT EXISTS public.referral_bonus_grants (
  id BIGSERIAL PRIMARY KEY,
  referrer_id BIGINT NOT NULL REFERENCES public.users(id),
  referred_user_id BIGINT NOT NULL REFERENCES public.users(id),
  beneficiary_user_id BIGINT NOT NULL REFERENCES public.users(id),
  bonus_type TEXT NOT NULL CHECK (bonus_type IN ('new_user', 'referrer')),
  duration_days INTEGER NOT NULL CHECK (duration_days > 0),
  previous_expires_at TIMESTAMPTZ,
  new_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_at TIMESTAMPTZ,
  CONSTRAINT referral_bonus_grants_unique_award UNIQUE (referrer_id, referred_user_id, bonus_type)
);
CREATE INDEX IF NOT EXISTS idx_referral_bonus_grants_beneficiary
  ON public.referral_bonus_grants (beneficiary_user_id, created_at DESC);
COMMIT;
