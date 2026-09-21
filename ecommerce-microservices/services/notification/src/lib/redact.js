/**
 * Log-safe renderings of personal data. `maskEmail` keeps just enough to
 * recognise an address while debugging ("o***@example.com"); the domain is
 * kept because it is what usually explains a delivery failure.
 */
export function maskEmail(address) {
  if (typeof address !== 'string' || !address.includes('@')) return '[invalid]';
  const [local, domain] = address.split('@');
  const head = local.slice(0, 1);
  return `${head}***@${domain}`;
}

/** amqp://user:pass@host → amqp://***@host (for logs and /health). */
export function maskUrl(url) {
  return String(url).replace(/\/\/[^@/]+@/, '//***@');
}
