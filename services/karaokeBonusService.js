import { activateSubscription } from './subscriptionService.js';

export const karaokeTesterTransactionId = userId => `karaoke-tester:${userId}`;

export async function grantKaraokeTesterBonus(pool, userId, { cache, activate = activateSubscription } = {}) {
  const transactionId = karaokeTesterTransactionId(userId);
  try {
    return await activate(pool, {
      userId,
      tariff: 'plus',
      durationDays: 30,
      source: 'karaoke_test',
      transactionId
    }, { cache });
  } catch (error) {
    if (error?.code !== '23505') throw error;
    const existing = await pool.query(
      'SELECT result_tariff, new_expires_at FROM subscription_activation_log WHERE transaction_id = $1',
      [transactionId]
    );
    if (!existing.rowCount) throw error;
    return { tariff: existing.rows[0].result_tariff, expiresAt: existing.rows[0].new_expires_at, duplicate: true };
  }
}
