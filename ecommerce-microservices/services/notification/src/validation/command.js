/**
 * The notification COMMAND contract — exactly what the Order Service's
 * OutboxWriter.notification() publishes (Step 6, documented in
 * services/order/src/main/java/com/orderflow/order/outbox/OutboxWriter.java):
 *
 *   { messageId: "notify-<orderId>-<routingKey>",   ← stable; the dedupe key
 *     commandType: "SendOrderConfirmation" | "SendOrderCancellation",
 *     version: 1, source: "order", occurredAt: ISO-8601, correlationId,
 *     orderId (UUID), userId (Clerk id), status ("CONFIRMED" | "CANCELLED" | "FAILED" | …),
 *     totalInPaise (int), currency ("INR"), reason? (cancellation only),
 *     items: [ { productId, sku, name, quantity, unitPriceInPaise, lineTotalInPaise } ] }
 *
 * Every incoming body is parsed with this schema BEFORE anything else
 * happens. A body that fails is malformed — it will never succeed no matter
 * how often it is retried — so the consumer routes it to the DLQ at once
 * (UnprocessableError) instead of burning retry attempts on it.
 *
 * Unknown extra fields are tolerated (a producer may add fields in a minor
 * version); `version` must be 1 (a major bump is a new contract, and an
 * unknown one is unprocessable rather than silently mis-rendered).
 */
import { z } from 'zod';
import { UnprocessableError } from '../lib/errors.js';

const paise = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const id = z.string().trim().min(1).max(200);

export const COMMAND_TYPES = ['SendOrderConfirmation', 'SendOrderCancellation'];

export const orderItemSchema = z.object({
  productId: id,
  sku: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(500),
  quantity: z.number().int().min(1).max(1_000_000),
  unitPriceInPaise: paise,
  lineTotalInPaise: paise,
}).loose();

export const notificationCommandSchema = z.object({
  messageId: id,
  commandType: z.enum(COMMAND_TYPES),
  version: z.literal(1),
  source: id,
  occurredAt: z.iso.datetime({ offset: true }),
  correlationId: z.string().trim().max(200).optional(),
  orderId: z.uuid(),
  userId: z.string().trim().regex(/^[A-Za-z0-9._-]{1,128}$/),
  status: z.string().trim().min(1).max(50),
  totalInPaise: paise,
  currency: z.string().trim().length(3).toUpperCase(),
  reason: z.string().trim().max(2000).optional(),
  items: z.array(orderItemSchema).min(1).max(500),
}).loose();

/**
 * Parse raw bytes → validated command. Throws UnprocessableError with a
 * compact list of problems ("items[0].quantity: expected int ≥ 1").
 */
export function parseCommand(buffer) {
  let json;
  try {
    json = JSON.parse(buffer.toString('utf8'));
  } catch (err) {
    throw new UnprocessableError('invalid_json', `body is not valid JSON: ${err.message}`);
  }
  const result = notificationCommandSchema.safeParse(json);
  if (!result.success) {
    const details = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new UnprocessableError('schema_violation', `command failed validation (${details.length} problem${details.length === 1 ? '' : 's'})`, details);
  }
  return result.data;
}
