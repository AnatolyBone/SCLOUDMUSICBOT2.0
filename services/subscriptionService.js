const TARIFF_KEYS = { free: 'daily_limit_free', plus: 'daily_limit_plus', pro: 'daily_limit_pro', unlimited: 'daily_limit_unlimited' };

export function normalizeTariff(value) {
  const raw = String(value || '').trim().toLowerCase();
  const tariff = raw === 'pluss' ? 'plus' : raw;
  if (!Object.hasOwn(TARIFF_KEYS, tariff)) throw new Error('Неизвестный тариф.');
  return tariff;
}

export async function activateSubscription(pool, { userId, tariff, durationDays, source, transactionId }, { cache } = {}) {
  const normalizedTariff = normalizeTariff(tariff);
  const days = Number(durationDays);
  if (!/^\d{1,20}$/.test(String(userId)) || !Number.isInteger(days) || days <= 0 || days > 3650) throw new Error('Некорректные параметры подписки.');
  if (!String(source || '').trim() || !String(transactionId || '').trim()) throw new Error('Источник и transactionId обязательны.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const duplicate = await client.query('SELECT result_tariff, new_expires_at FROM subscription_activation_log WHERE transaction_id = $1', [transactionId]);
    if (duplicate.rowCount) { await client.query('COMMIT'); return { tariff: duplicate.rows[0].result_tariff, expiresAt: duplicate.rows[0].new_expires_at, duplicate: true }; }
    const current = await client.query('SELECT premium_limit, premium_until FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!current.rowCount) throw new Error('Пользователь не найден.');
    const setting = await client.query('SELECT value::int AS value FROM app_settings WHERE key = $1', [TARIFF_KEYS[normalizedTariff]]);
    const limit = normalizedTariff === 'unlimited' ? null : Number(setting.rows[0]?.value);
    if (normalizedTariff !== 'unlimited' && !Number.isInteger(limit)) throw new Error('Настройка тарифа отсутствует.');
    const old = current.rows[0];
    const updated = await client.query(`UPDATE users SET tariff_code=$5, premium_limit=$2, premium_until=GREATEST(COALESCE(premium_until, NOW()), NOW()) + ($3 * INTERVAL '1 day'), subscribed_bonus_used = CASE WHEN $4 = 'channel_subscription' THEN TRUE ELSE subscribed_bonus_used END WHERE id=$1 RETURNING premium_until`, [userId, limit, days, source, normalizedTariff]);
    await client.query(`INSERT INTO subscription_activation_log(user_id, old_tariff, result_tariff, old_expires_at, new_expires_at, source, transaction_id, result) VALUES($1,$2,$3,$4,$5,$6,$7,'success')`, [userId, old.premium_limit, normalizedTariff, old.premium_until, updated.rows[0].premium_until, source, transactionId]);
    await client.query('COMMIT');
    try { await cache?.del(`user:${userId}:subscription`); } catch (error) { console.error('[Subscription Cache] Invalidation failed:', error.message); }
    return { tariff: normalizedTariff, expiresAt: updated.rows[0].premium_until, duplicate: false };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
