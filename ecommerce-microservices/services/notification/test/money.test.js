import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPaise } from '../src/lib/money.js';

test('129900 paise renders as ₹1,299.00 (the canonical example)', () => {
  assert.equal(formatPaise(129900), '₹1,299.00');
});

test('edge cases: zero, single paise, sub-rupee, exact rupees', () => {
  assert.equal(formatPaise(0), '₹0.00');
  assert.equal(formatPaise(1), '₹0.01');
  assert.equal(formatPaise(99), '₹0.99');
  assert.equal(formatPaise(100), '₹1.00');
  assert.equal(formatPaise(105), '₹1.05');
  assert.equal(formatPaise(99999), '₹999.99');
});

test('Indian digit grouping for large values (lakh / crore)', () => {
  assert.equal(formatPaise(10000000), '₹1,00,000.00');            // 1 lakh
  assert.equal(formatPaise(100000000), '₹10,00,000.00');          // 10 lakh
  assert.equal(formatPaise(1000000000), '₹1,00,00,000.00');       // 1 crore
  assert.equal(formatPaise(123456789012), '₹1,23,45,67,890.12');
  assert.equal(formatPaise(Number.MAX_SAFE_INTEGER), '₹9,00,71,99,25,47,409.91');
});

test('exact arithmetic — no floating point drift on awkward values', () => {
  // 0.1 + 0.2 style values in paise must never show as 1234.5599999
  assert.equal(formatPaise(123456), '₹1,234.56');
  assert.equal(formatPaise(4569), '₹45.69');
  assert.equal(formatPaise(1005), '₹10.05');
});

test('non-INR currencies fall back to "CODE amount"', () => {
  assert.equal(formatPaise(129900, 'USD'), 'USD 1,299.00');
});

test('rejects anything that is not a non-negative safe integer', () => {
  assert.throws(() => formatPaise(-1), RangeError);
  assert.throws(() => formatPaise(12.5), TypeError);
  assert.throws(() => formatPaise('129900'), TypeError);
  assert.throws(() => formatPaise(NaN), TypeError);
  assert.throws(() => formatPaise(Number.MAX_SAFE_INTEGER + 1), TypeError);
  assert.throws(() => formatPaise(undefined), TypeError);
});
