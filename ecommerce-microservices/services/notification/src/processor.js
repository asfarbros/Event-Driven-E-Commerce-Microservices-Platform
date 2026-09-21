/**
 * Processing one command, channel-agnostic:
 *
 *   parse + validate (zod)          malformed → UnprocessableError → DLQ now
 *   claim messageId in the ledger   already sent → { kind: 'duplicate' }
 *   resolve recipient (userId → e-mail)
 *   render template (paise → rupees happens inside)
 *   channel.send(envelope)          throws → transient → retry
 *   ledger.markSent
 *
 * Any throw that is not UnprocessableError is treated by the worker as
 * transient. On failure the claim is released so the retry can claim again.
 */
import { parseCommand } from './validation/command.js';
import { render, templateFor } from './templates/index.js';
import { UnprocessableError, describeError } from './lib/errors.js';
import { maskEmail } from './lib/redact.js';

export function createProcessor({ config, channel, recipients, ledger }) {
  async function process({ content, props, attempt, requestId, log }) {
    const cmd = parseCommand(content);
    if (props.messageId && props.messageId !== cmd.messageId) {
      log.warn({ amqpMessageId: props.messageId }, 'AMQP messageId differs from body messageId — using the body (the contract)');
    }
    if (!templateFor(cmd)) throw new UnprocessableError('unknown_command_type', `no template for ${cmd.commandType}`);

    const claim = await ledger.claim(cmd.messageId, { orderId: cmd.orderId, userId: cmd.userId, commandType: cmd.commandType, requestId, attempt });
    if (claim.outcome === 'duplicate') return { kind: 'duplicate', sentAt: claim.sentAt, instance: claim.instance };
    if (claim.outcome === 'in_flight') {
      throw new Error(`message is being sent by another worker (${claim.instance || 'unknown'}) — will re-check after backoff`);
    }
    if (claim.tookOverFrom) log.warn({ tookOverFrom: claim.tookOverFrom }, 'took over a stale claim from a worker that died mid-send');

    try {
      const recipient = await recipients.resolve(cmd.userId);
      const rendered = render(cmd);
      const result = await channel.send({
        from: config.delivery.from,
        to: recipient.to,
        toName: recipient.toName,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        meta: { messageId: cmd.messageId, orderId: cmd.orderId, userId: cmd.userId, requestId, template: rendered.template, attempt, channel: channel.name },
      });
      let ledgerState = 'recorded';
      try {
        await ledger.markSent(cmd.messageId, { template: rendered.template, channel: channel.name, providerMessageId: result?.providerMessageId, attempt });
      } catch (err) {
        // The e-mail is out; never retry (that guarantees a duplicate). The stale
        // claim expires after the claim TTL — a redelivery inside that window is
        // parked as in-flight, after it would send again (documented trade-off).
        ledgerState = 'not-recorded';
        log.error({ error: describeError(err) }, 'sent, but the ledger could not be updated — acking anyway to avoid a guaranteed duplicate');
      }
      return {
        kind: 'sent', template: rendered.template, channel: channel.name, toMasked: maskEmail(recipient.to), userId: cmd.userId,
        providerMessageId: result?.providerMessageId, ledger: ledgerState,
      };
    } catch (err) {
      await ledger.release(cmd.messageId).catch((e) => log.warn({ error: describeError(e) }, 'could not release claim after failure'));
      throw err;
    }
  }

  return { process };
}
