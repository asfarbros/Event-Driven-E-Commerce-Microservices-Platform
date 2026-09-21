/**
 * Money — THE one place integer paise become a rupee string.
 *
 * Every amount in the system is an integer number of paise (`priceInPaise`,
 * `totalInPaise`, …) computed by the server. The UI only DISPLAYS them: no
 * arithmetic beyond this formatting, no floats. Exact integer maths, Indian
 * digit grouping (lakh / crore):
 *
 *   formatPaise(129900)    → "₹1,299.00"
 *   formatPaise(10000000)  → "₹1,00,000.00"
 *   formatPaise(0)         → "₹0.00"
 *   formatPaise(1)         → "₹0.01"
 */
const SYMBOLS: Record<string, string> = { INR: '₹' };

function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const groups: string[] = [];
  while (rest.length > 2) { groups.unshift(rest.slice(-2)); rest = rest.slice(0, -2); }
  if (rest) groups.unshift(rest);
  return `${groups.join(',')},${last3}`;
}

export function formatPaise(paise: number | null | undefined, currency = 'INR'): string {
  if (paise === null || paise === undefined || typeof paise !== 'number' || !Number.isSafeInteger(paise)) {
    // Never render ₹0 or NaN for a missing/unpriced amount — the caller shows "unavailable".
    return '—';
  }
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const fraction = abs - rupees * 100;
  const whole = groupIndian(String(rupees));
  const cents = String(fraction).padStart(2, '0');
  const symbol = SYMBOLS[currency];
  const body = symbol ? `${symbol}${whole}.${cents}` : `${currency} ${whole}.${cents}`;
  return negative ? `−${body}` : body;
}

/** True when a value is a real, displayable amount (guards ₹0/NaN on degraded data). */
export function isAmount(paise: unknown): paise is number {
  return typeof paise === 'number' && Number.isSafeInteger(paise);
}
