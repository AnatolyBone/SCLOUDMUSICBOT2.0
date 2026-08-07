export const REFERRAL_BONUS_DAYS = 3;
export const REFERRAL_BONUS_TYPES = Object.freeze({ NEW_USER: 'new_user', REFERRER: 'referrer' });

export async function grantReferralBonus(pool, { referrerId, referredUserId, bonusType }) {
  const referrer = String(referrerId);
  const referred = String(referredUserId);
  if (!/^\d{1,20}$/.test(referrer) || !/^\d{1,20}$/.test(referred)) throw new Error('Invalid referral bonus user id.');
  if (!Object.values(REFERRAL_BONUS_TYPES).includes(bonusType)) throw new Error('Invalid referral bonus type.');
  const beneficiaryId = bonusType === REFERRAL_BONUS_TYPES.NEW_USER ? referred : referrer;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO referral_bonus_grants
         (referrer_id, referred_user_id, beneficiary_user_id, bonus_type, duration_days)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (referrer_id, referred_user_id, bonus_type) DO NOTHING
       RETURNING id`,
      [referrer, referred, beneficiaryId, bonusType, REFERRAL_BONUS_DAYS]
    );
    if (!claim.rowCount) {
      await client.query('COMMIT');
      return { duplicate: true, bonusType, beneficiaryId };
    }
    const current = await client.query('SELECT premium_limit, premium_until, tariff_code FROM users WHERE id = $1 FOR UPDATE', [beneficiaryId]);
    if (!current.rowCount) throw new Error('Referral bonus beneficiary not found.');
    const setting = await client.query("SELECT value::int AS value FROM app_settings WHERE key = 'daily_limit_plus'");
    const plusLimit = Number(setting.rows[0]?.value);
    if (!Number.isInteger(plusLimit)) throw new Error('Plus tariff setting is missing.');
    const old = current.rows[0];
    const preserveCurrent = bonusType === REFERRAL_BONUS_TYPES.REFERRER && Number(old.premium_limit) > plusLimit;
    const resultLimit = preserveCurrent ? Number(old.premium_limit) : plusLimit;
    const resultTariff = preserveCurrent && ['pro', 'unlimited'].includes(old.tariff_code) ? old.tariff_code : (preserveCurrent ? 'pro' : 'plus');
    const updated = await client.query(
      `UPDATE users SET tariff_code=$2, premium_limit=$3,
       premium_until=GREATEST(COALESCE(premium_until,NOW()),NOW()) + ($4 * INTERVAL '1 day'),
       premium_notified=FALSE, premium_expiring_notified=FALSE
       WHERE id=$1 RETURNING premium_until`,
      [beneficiaryId, resultTariff, resultLimit, REFERRAL_BONUS_DAYS]
    );
    await client.query(
      'UPDATE referral_bonus_grants SET previous_expires_at=$2, new_expires_at=$3, granted_at=NOW() WHERE id=$1',
      [claim.rows[0].id, old.premium_until, updated.rows[0].premium_until]
    );
    await client.query('COMMIT');
    return { duplicate: false, bonusType, beneficiaryId, limit: resultLimit, tariff: resultTariff, expiresAt: updated.rows[0].premium_until };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
