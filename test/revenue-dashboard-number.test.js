import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { toFiniteNumber } from '../services/revenueNumber.js';

test('PostgreSQL NUMERIC and BIGINT strings normalize to finite numbers', () => {
  assert.equal(toFiniteNumber('1234.56'), 1234.56);
  assert.equal(toFiniteNumber('4294967296'), 4_294_967_296);
  assert.equal(toFiniteNumber(null), 0);
  assert.equal(toFiniteNumber('not-a-number'), 0);
  assert.equal(toFiniteNumber(Infinity), 0);
});

test('Revenue Dashboard uses backend normalization and a safe frontend formatter', async () => {
  const dbSource = await readFile(new URL('../db.js', import.meta.url), 'utf8');
  const analyticsView = await readFile(new URL('../views/analytics.ejs', import.meta.url), 'utf8');

  assert.match(dbSource, /rub: toFiniteNumber\(todayRes\.rows\[0\]\?\.rub\)/);
  assert.match(dbSource, /stars: toFiniteNumber\(todayRes\.rows\[0\]\?\.stars\)/);
  assert.match(analyticsView, /function formatRevenueNumber\(value, fractionDigits = 2\)/);
  assert.match(analyticsView, /Number\.isFinite\(number\)/);
  assert.doesNotMatch(analyticsView, /d\.today\.totalRubEquivalent\.toFixed/);
});
