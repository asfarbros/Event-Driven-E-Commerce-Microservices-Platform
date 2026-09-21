/**
 * Console channel — the default for local development and demos.
 *
 * "Sends" the message by printing a readable, boxed rendering to stdout
 * (deliberately NOT a JSON log line: this is the mock inbox, the thing you
 * look at in a demo). The structured JSON log line that accompanies it comes
 * from the consumer, with the recipient masked. The address is masked here
 * too, because this output ends up in the same terminal as the logs.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { maskEmail } from '../lib/redact.js';

const WIDTH = 72;

function line(ch = '─') { return ch.repeat(WIDTH); }
function row(label, value) { return `  ${label.padEnd(10)}${value}`; }

export function renderConsoleMessage(envelope) {
  const { meta = {} } = envelope;
  const header = `  📧  ${meta.template ? meta.template.replace(/-/g, ' ').toUpperCase() : 'NOTIFICATION'}`.padEnd(WIDTH - 22)
    + `#${meta.attempt ?? 1}${meta.channel ? ` via ${meta.channel}` : ''}`;
  const out = [
    '',
    `┌${line()}┐`,
    `│${header.padEnd(WIDTH)}│`,
    `├${line()}┤`,
    row('From:', envelope.from),
    row('To:', `${envelope.toName ? `${envelope.toName} ` : ''}<${maskEmail(envelope.to)}>`),
    row('Subject:', envelope.subject),
    ...(meta.orderId ? [row('Order:', meta.orderId)] : []),
    ...(meta.requestId ? [row('Trace:', `X-Request-Id ${meta.requestId}`)] : []),
    `├${line()}┤`,
    ...envelope.text.split('\n').map((l) => `  ${l}`),
    `└${line()}┘`,
    '',
  ];
  return out.join('\n');
}

export function createConsoleChannel(delivery, logger, stream = process.stdout) {
  const log = logger.child({ component: 'channel', channel: 'console' });
  return {
    name: 'console',
    async send(envelope) {
      // Simulated provider latency (demos: makes in-flight work and the split between competing consumers visible).
      if (delivery.consoleDelayMs > 0) await sleep(delivery.consoleDelayMs);
      await new Promise((resolve, reject) => stream.write(renderConsoleMessage(envelope), (err) => (err ? reject(err) : resolve())));
      return { providerMessageId: `console-${Date.now().toString(36)}` };
    },
    async verify() { log.info('console channel ready — messages are printed to stdout, nothing is sent'); },
    async close() {},
    describe() { return { name: 'console', from: delivery.from, simulatedDelayMs: delivery.consoleDelayMs }; },
  };
}
