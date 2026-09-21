/**
 * SMTP channel (nodemailer) — real e-mail, disabled by default
 * (NOTIFICATION_CHANNEL=smtp enables it). Point SMTP_HOST/SMTP_PORT at the
 * Mailpit container from infra/docker-compose.yml (SMTP 1025, inbox UI
 * http://localhost:8025) to demonstrate real sending with no provider.
 *
 * A pooled transport is used so retries do not pay a new TCP+EHLO handshake
 * each time. Every error nodemailer raises (ECONNREFUSED, ETIMEDOUT, a 4xx/5xx
 * SMTP reply) is transient from the consumer's point of view → retry path.
 */
import nodemailer from 'nodemailer';

export function createSmtpChannel(delivery, logger) {
  const { smtp } = delivery;
  const log = logger.child({ component: 'channel', channel: 'smtp', host: smtp.host, port: smtp.port });

  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
    pool: true,
    maxConnections: 2,
    connectionTimeout: smtp.timeoutMs,
    greetingTimeout: smtp.timeoutMs,
    socketTimeout: smtp.timeoutMs,
  });

  return {
    name: 'smtp',
    async send(envelope) {
      const info = await transport.sendMail({
        from: envelope.from,
        to: envelope.toName ? { name: envelope.toName, address: envelope.to } : envelope.to,
        subject: envelope.subject,
        text: envelope.text,
        html: envelope.html,
        headers: {
          'X-Request-Id': envelope.meta?.requestId ?? '',
          'X-OrderFlow-Message-Id': envelope.meta?.messageId ?? '',
          'X-OrderFlow-Order-Id': envelope.meta?.orderId ?? '',
        },
      });
      return { providerMessageId: info.messageId, response: info.response };
    },
    async verify() {
      try {
        await transport.verify();
        log.info('smtp channel ready');
      } catch (err) {
        // Not fatal: the server may come up later; every send is retried anyway.
        log.warn({ reason: err.message?.split('\n')[0] }, 'smtp server not reachable at boot — deliveries will retry');
      }
    },
    async close() { transport.close(); },
    describe() { return { name: 'smtp', host: smtp.host, port: smtp.port, secure: smtp.secure, auth: Boolean(smtp.user), from: delivery.from }; },
  };
}
