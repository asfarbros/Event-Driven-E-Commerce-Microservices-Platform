import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPaise, isAmount } from './money.ts';

test('canonical examples', () => {
  assert.equal(formatPaise(129900), '₹1,299.00');
  assert.equal(formatPaise(10000000), '₹1,00,000.00');
});
test('edge cases', () => {
  assert.equal(formatPaise(0), '₹0.00');
  assert.equal(formatPaise(1), '₹0.01');
  assert.equal(formatPaise(99), '₹0.99');
  assert.equal(formatPaise(100), '₹1.00');
  assert.equal(formatPaise(1005), '₹10.05');
  assert.equal(formatPaise(123456), '₹1,234.56');   // no floating point drift
  assert.equal(formatPaise(1000000000), '₹1,00,00,000.00');
  assert.equal(formatPaise(123456789012), '₹1,23,45,67,890.12');
  assert.equal(formatPaise(Number.MAX_SAFE_INTEGER), '₹9,00,71,99,25,47,409.91');
});
test('missing or invalid amounts never render as ₹0 or NaN', () => {
  assert.equal(formatPaise(null), '—');
  assert.equal(formatPaise(undefined), '—');
  assert.equal(formatPaise(Number.NaN), '—');
  assert.equal(formatPaise(12.5), '—');
  assert.equal(isAmount(null), false);
  assert.equal(isAmount(129900), true);
});
test('other currencies fall back to the code', () => {
  assert.equal(formatPaise(129900, 'USD'), 'USD 1,299.00');
});
