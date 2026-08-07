SELECT to_regclass('public.referral_bonus_grants') AS referral_bonus_grants_table;
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.referral_bonus_grants'::regclass
  AND conname = 'referral_bonus_grants_unique_award';
