import test from 'node:test';
import assert from 'node:assert/strict';
import { grantReferralBonus, REFERRAL_BONUS_TYPES } from '../services/referralBonusService.js';
import { grantKaraokeTesterBonus, karaokeTesterTransactionId } from '../services/karaokeBonusService.js';

function referralPool() {
  const state = { grants: new Set(), extensions: 0, releases: 0 };
  return {
    state,
    async connect() {
      return {
        async query(sql, params = []) {
          if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql)) return { rowCount: 0, rows: [] };
          if (sql.includes('INSERT INTO referral_bonus_grants')) {
            const key = `${params[0]}:${params[1]}:${params[3]}`;
            if (state.grants.has(key)) return { rowCount: 0, rows: [] };
            state.grants.add(key);
            return { rowCount: 1, rows: [{ id: state.grants.size }] };
          }
          if (sql.includes('FROM users') && sql.includes('FOR UPDATE')) {
            return { rowCount: 1, rows: [{ premium_limit: 30, premium_until: null, tariff_code: 'plus' }] };
          }
          if (sql.includes('FROM app_settings')) return { rowCount: 1, rows: [{ value: 30 }] };
          if (sql.includes('UPDATE users')) {
            state.extensions += 1;
            return { rowCount: 1, rows: [{ premium_until: new Date('2026-08-10T00:00:00Z') }] };
          }
          if (sql.includes('UPDATE referral_bonus_grants')) return { rowCount: 1, rows: [] };
          throw new Error(`Unexpected SQL: ${sql}`);
        },
        release() { state.releases += 1; }
      };
    }
  };
}

test('two parallel referral callbacks extend a bonus only once', async () => {
  const pool = referralPool();
  const request = { referrerId: 100, referredUserId: 200, bonusType: REFERRAL_BONUS_TYPES.REFERRER };
  const results = await Promise.all([grantReferralBonus(pool, request), grantReferralBonus(pool, request)]);
  assert.equal(pool.state.extensions, 1);
  assert.deepEqual(results.map(result => result.duplicate).sort(), [false, true]);
});

test('referral retry after a successful grant does not extend again', async () => {
  const pool = referralPool();
  const request = { referrerId: 100, referredUserId: 200, bonusType: REFERRAL_BONUS_TYPES.NEW_USER };
  assert.equal((await grantReferralBonus(pool, request)).duplicate, false);
  assert.equal((await grantReferralBonus(pool, request)).duplicate, true);
  assert.equal(pool.state.extensions, 1);
});

test('two karaoke callbacks use one stable transaction id and grant once', async () => {
  const seen = new Set();
  let extensions = 0;
  const activate = async (_pool, request) => {
    if (seen.has(request.transactionId)) return { duplicate: true, tariff: request.tariff };
    seen.add(request.transactionId);
    extensions += 1;
    return { duplicate: false, tariff: request.tariff };
  };
  const pool = {};
  const results = await Promise.all([
    grantKaraokeTesterBonus(pool, 321, { activate }),
    grantKaraokeTesterBonus(pool, 321, { activate })
  ]);
  assert.equal(extensions, 1);
  assert.equal(seen.has('karaoke-tester:321'), true);
  assert.deepEqual(results.map(result => result.duplicate).sort(), [false, true]);
});

test('karaoke retry after success keeps the same transaction id', async () => {
  const transactionIds = [];
  const activate = async (_pool, request) => {
    transactionIds.push(request.transactionId);
    return { duplicate: transactionIds.length > 1, tariff: request.tariff };
  };
  await grantKaraokeTesterBonus({}, 987, { activate });
  const retry = await grantKaraokeTesterBonus({}, 987, { activate });
  assert.equal(retry.duplicate, true);
  assert.deepEqual(transactionIds, [karaokeTesterTransactionId(987), karaokeTesterTransactionId(987)]);
});
