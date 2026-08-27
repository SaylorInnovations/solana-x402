// Offline smoke tests — no network required, no test framework required.
// Anything that needs a live RPC/facilitator call is exercised in
// examples/ instead, against a real deployment.
'use strict';
const assert = require('assert');
const Pay = require('../src/pay.js');
const { X402 } = require('../index.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('ok - ' + name);
}

test('base58 encode uses only the expected alphabet', () => {
  const ALPHABET = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;
  const encoded = Pay.b58encode(Buffer.from('hello world'));
  assert.match(encoded, ALPHABET);
});

test('newReference produces a 32-byte-derived base58 string each time, never repeating', () => {
  const a = Pay.newReference();
  const b = Pay.newReference();
  assert.notStrictEqual(a, b);
  assert.ok(a.length > 30);
});

test('HMAC session tokens round-trip and reject tampering', () => {
  const secret = 'test-secret';
  const tok = Pay.sign({ id: 'abc', minAmount: 1000 }, secret);
  const decoded = Pay.verifyToken(tok, secret);
  assert.deepStrictEqual(decoded.id, 'abc');
  assert.strictEqual(Pay.verifyToken(tok, 'wrong-secret'), null);
  assert.strictEqual(Pay.verifyToken(tok + 'x', secret), null);
});

test('HMAC session tokens expire', () => {
  const secret = 'test-secret';
  const tok = Pay.sign({ id: 'abc', exp: Date.now() - 1000 }, secret);
  assert.strictEqual(Pay.verifyToken(tok, secret), null);
});

test('X402 requires a secret', () => {
  assert.throws(() => new X402({}), /secret/);
});

test('readPayment parses a base64 X-PAYMENT header', () => {
  const x402 = new X402({ secret: 's' });
  const raw = Buffer.from(JSON.stringify({ payload: { signature: 'sig123' } })).toString('base64');
  const parsed = x402.readPayment({ 'x-payment': raw });
  assert.strictEqual(parsed.payload.signature, 'sig123');
});

test('readPayment returns null with no header', () => {
  const x402 = new X402({ secret: 's' });
  assert.strictEqual(x402.readPayment({}), null);
});

test('settle() rejects a payload with none of transaction/session/signature', async () => {
  const x402 = new X402({ secret: 's', payTo: 'somewallet' });
  const result = await x402.settle({ payload: {} }, { id: 'x', price: 1000 }, 'https://example.com/x');
  assert.strictEqual(result.ok, false);
});

console.log('\n' + passed + ' passed');
