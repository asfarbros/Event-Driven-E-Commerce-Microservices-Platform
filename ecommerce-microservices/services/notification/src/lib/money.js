/**
 * Money rendering — THE one place integer paise become a human string.
 *
 * Every other service stores and transmits money as integer paise
 * (`totalInPaise`, `unitPriceInPaise`, …) and never as floats. This worker is
 * the only place a customer-facing amount is produced, so the conversion
 * lives here, is exact (integer arithmetic, no division by 100 in floating
 * point) and is unit-tested for the edge cases.
 *
 *   formatPaise(129900)  → "₹1,299.00"
 *   formatPaise(0)       → "₹0.00"
 *   formatPaise(1)       → "₹0.01"
 *   formatPaise(100000000) → "₹10,00,000.00"   (Indian lakh/crore grouping)
 */

const CURRENCY_SYMBOLS = { INR: '₹' };

/** Group the integer part with Indian digit grouping: last 3, then 2s. */
function groupIndian(digits) {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const groups = [];
  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) groups.unshift(rest);
  return `${groups.join(',')},${last3}`;
}

/**
 * @param {number} paise  integer, 0 ≤ paise ≤ Number.MAX_SAFE_INTEGER
 * @param {string} currency ISO code; only INR has a symbol, others render as "CODE 12.34"
 */
export function formatPaise(paise, currency = 'INR') {
  if (typeof paise !== 'number' || !Number.isSafeInteger(paise)) {
    throw new TypeError(`amount must be a safe integer number of paise (got ${typeof paise} ${String(paise)})`);
  }
  if (paise < 0) throw new RangeError(`amount must not be negative (got ${paise})`);
  const rupees = Math.floor(paise / 100);          // exact for safe integers
  const fraction = paise - rupees * 100;            // exact, 0..99
  const whole = groupIndian(String(rupees));
  const cents = String(fraction).padStart(2, '0');
  const symbol = CURRENCY_SYMBOLS[currency];
  return symbol ? `${symbol}${whole}.${cents}` : `${currency} ${whole}.${cents}`;
}
