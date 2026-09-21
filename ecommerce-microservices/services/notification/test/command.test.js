import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/validation/command.js';
import { UnprocessableError } from '../src/lib/errors.js';
import { confirmationCommand, cancellationCommand, encode } from './helpers/fixtures.js';

test('accepts the exact shape the Order Service publishes', () => {
  const cmd = parseCommand(encode(confirmationCommand()));
  assert.equal(cmd.commandType, 'SendOrderConfirmation');
  assert.equal(cmd.totalInPaise, 129900);
  assert.equal(cmd.items.length, 2);
  const cancel = parseCommand(encode(cancellationCommand()));
  assert.equal(cancel.reason, 'cancelled by user after payment — refund requested');
});

test('tolerates unknown extra fields (forward-compatible minor versions)', () => {
  const cmd = parseCommand(encode(confirmationCommand({ shippingEta: '2 days', items: [{ ...confirmationCommand().items[0], imageUrl: 'x' }] })));
  assert.equal(cmd.shippingEta, '2 days');
});

const malformed = {
  'not JSON at all': Buffer.from('this is not json'),
  'empty body': Buffer.alloc(0),
  'missing messageId': encode({ ...confirmationCommand(), messageId: undefined }),
  'unknown commandType': encode(confirmationCommand({ commandType: 'SendPigeon' })),
  'wrong version': encode(confirmationCommand({ version: 2 })),
  'orderId not a UUID': encode(confirmationCommand({ orderId: 'order-1' })),
  'money as a float string': encode(confirmationCommand({ totalInPaise: '1299.00' })),
  'money as a float': encode(confirmationCommand({ totalInPaise: 1299.5 })),
  'negative money': encode(confirmationCommand({ totalInPaise: -1 })),
  'no items': encode(confirmationCommand({ items: [] })),
  'zero quantity': encode(confirmationCommand({ items: [{ ...confirmationCommand().items[0], quantity: 0 }] })),
  'bad occurredAt': encode(confirmationCommand({ occurredAt: 'yesterday' })),
  'userId with spaces': encode(confirmationCommand({ userId: 'user 1' })),
  'JSON but not an object': encode([1, 2, 3]),
};

for (const [name, body] of Object.entries(malformed)) {
  test(`rejects as UnprocessableError: ${name}`, () => {
    assert.throws(() => parseCommand(body), (err) => {
      assert.ok(err instanceof UnprocessableError, `expected UnprocessableError, got ${err?.name}`);
      assert.ok(['invalid_json', 'schema_violation'].includes(err.code));
      return true;
    });
  });
}

test('schema violations list every problem with its path', () => {
  try {
    parseCommand(encode(confirmationCommand({ orderId: 'nope', totalInPaise: -5, items: [] })));
    assert.fail('should throw');
  } catch (err) {
    assert.equal(err.code, 'schema_violation');
    assert.equal(err.details.length, 3);
    assert.ok(err.details.some((d) => d.startsWith('orderId:')));
    assert.ok(err.details.some((d) => d.startsWith('totalInPaise:')));
    assert.ok(err.details.some((d) => d.startsWith('items:')));
  }
});
