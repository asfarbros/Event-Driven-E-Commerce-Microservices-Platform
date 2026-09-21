/**
 * Deduplication ledger — "the same messageId never sends two e-mails".
 *
 * WHY A STORE AT ALL. Both producers of duplicates are real: the Order
 * Service's outbox relay is at-least-once (a crash between publish and
 * "mark published" republishes), and RabbitMQ redelivers any message whose
 * consumer died before acking. An in-memory set would forget on restart —
 * exactly when redelivery happens — and cannot be shared by competing
 * consumers (two instances could each get one copy of a duplicate pair). So
 * the ledger is durable and shared: MongoDB, this worker's OWN database
 * (notification_db, guarded in config), one document per messageId.
 *
 * PROTOCOL (claim → send → mark):
 *   1. claim(messageId): insert {_id: messageId, status: 'sending'}.
 *        - inserted            → we own it: send.
 *        - exists, 'sent'      → duplicate: ack WITHOUT sending.
 *        - exists, 'sending',
 *          claimed < claimTtl  → another instance is sending it right now:
 *                                 treat as transient (retry later, re-check).
 *        - exists, 'sending',
 *          claim stale         → the previous owner died mid-send: take over.
 *   2. send via the channel.
 *   3. markSent(messageId)   on success  → status 'sent', expires after the
 *                                          retention window.
 *      release(messageId)    on failure  → delete the claim so a retry can
 *                                          claim it again.
 *
 * GUARANTEE + TRADE-OFF. This is at-least-once with a small window: if the
 * process dies AFTER the SMTP server accepted the mail but BEFORE markSent()
 * lands, the claim goes stale and the redelivery re-sends once. Closing that
 * window would need a transaction spanning SMTP and the database, which does
 * not exist; the alternative (mark 'sent' BEFORE sending) risks never sending
 * at all, which for a purchase confirmation is the worse failure. Retention:
 * NOTIFICATION_DEDUPE_RETENTION_HOURS (default 168 h = 7 days) via a TTL index
 * on `expiresAt` — long enough to cover any realistic redelivery, outbox
 * replay or manual DLQ replay; a replay older than that would send again.
 */
import mongoose from 'mongoose';

const sentNotificationSchema = new mongoose.Schema({
  _id: { type: String },                                   // messageId (notify-<orderId>-<routingKey>)
  status: { type: String, enum: ['sending', 'sent'], required: true },
  claimedAt: { type: Date, required: true },
  sentAt: { type: Date },
  expiresAt: { type: Date, required: true, index: { expires: 0 } }, // TTL: per-document expiry
  orderId: String,
  userId: String,
  commandType: String,
  template: String,
  channel: String,
  providerMessageId: String,
  requestId: String,
  attempt: Number,
  instance: String,
}, { collection: 'sent_notifications', versionKey: false });

export const SentNotification = mongoose.model('SentNotification', sentNotificationSchema);

export function createDedupeLedger({ claimTtlMs, retentionHours }, { instance }) {
  const retentionMs = retentionHours * 3600 * 1000;

  async function claim(messageId, facts = {}) {
    const now = new Date();
    const doc = { _id: messageId, status: 'sending', claimedAt: now, expiresAt: new Date(now.getTime() + claimTtlMs), instance, ...facts };
    try {
      await SentNotification.collection.insertOne(doc);
      return { outcome: 'claimed' };
    } catch (err) {
      if (err.code !== 11000) throw err;                    // duplicate key = someone has it; anything else is a real DB error
    }
    const existing = await SentNotification.findById(messageId).lean();
    if (!existing) {
      // Expired/removed between our insert and read — one retry of the insert.
      await SentNotification.collection.insertOne(doc);
      return { outcome: 'claimed' };
    }
    if (existing.status === 'sent') return { outcome: 'duplicate', sentAt: existing.sentAt, channel: existing.channel, instance: existing.instance };
    const staleBefore = new Date(now.getTime() - claimTtlMs);
    if (existing.claimedAt > staleBefore) return { outcome: 'in_flight', claimedAt: existing.claimedAt, instance: existing.instance };
    const taken = await SentNotification.findOneAndUpdate(
      { _id: messageId, status: 'sending', claimedAt: { $lte: staleBefore } },
      { $set: { claimedAt: now, expiresAt: new Date(now.getTime() + claimTtlMs), instance, ...facts } },
      { new: true },
    ).lean();
    return taken ? { outcome: 'claimed', tookOverFrom: existing.instance } : { outcome: 'in_flight', instance: existing.instance };
  }

  async function markSent(messageId, facts = {}) {
    const sentAt = new Date();
    await SentNotification.updateOne(
      { _id: messageId },
      { $set: { status: 'sent', sentAt, expiresAt: new Date(sentAt.getTime() + retentionMs), ...facts } },
    );
    return sentAt;
  }

  async function release(messageId) {
    await SentNotification.deleteOne({ _id: messageId, status: 'sending' });
  }

  return { claim, markSent, release, describe: () => ({ store: 'mongodb', collection: 'sent_notifications', retentionHours, claimTtlMs }) };
}
