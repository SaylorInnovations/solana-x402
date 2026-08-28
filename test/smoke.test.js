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

test('_bazaarBlock returns null without an outputSchema', () => {
  const x402 = new X402({ secret: 's' });
  assert.strictEqual(x402._bazaarBlock({ id: 'x', price: 1000 }), null);
});

test('_bazaarBlock returns null when resource.bazaar is false', () => {
  const x402 = new X402({ secret: 's' });
  assert.strictEqual(x402._bazaarBlock({ id: 'x', price: 1000, outputSchema: { type: 'object' }, bazaar: false }), null);
});

test('_bazaarBlock passes through a caller-supplied custom block untouched', () => {
  const x402 = new X402({ secret: 's' });
  const custom = { info: { input: { type: 'mcp', tool: 't', inputSchema: {} } }, schema: {} };
  assert.strictEqual(x402._bazaarBlock({ id: 'x', price: 1000, bazaar: custom }), custom);
});

// Locks in the shape the x402 bazaar extension spec requires
// (specs/extensions/bazaar.md in coinbase/x402): {info: {input, output},
// schema}, NOT the old {discoverable, category, tags, inputSchema,
// outputSchema} shape v0.1.0 shipped with. See _bazaarBlock()'s comment for
// why -- that old shape/location was confirmed against a real CDP account to
// silently catalog nothing at all.
test('_bazaarBlock without a routeTemplate advertises queryParams', () => {
  const x402 = new X402({ secret: 's' });
  const block = x402._bazaarBlock({
    id: 'price', price: 1000, method: 'GET',
    inputSchema: { mint: 'Solana mint address' },
    outputSchema: { type: 'object', properties: { price_usd: { type: 'number' } } }
  });
  assert.strictEqual(block.info.input.type, 'http');
  assert.strictEqual(block.info.input.method, 'GET');
  assert.deepStrictEqual(block.info.input.queryParams, { mint: 'mint' });
  assert.strictEqual(block.info.input.pathParams, undefined);
  assert.strictEqual(block.routeTemplate, undefined);
  assert.strictEqual(block.schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.deepStrictEqual(block.schema.required, ['input']);
  assert.deepStrictEqual(block.schema.properties.input.required, ['type', 'method', 'queryParams']);
});

test('_bazaarBlock with a routeTemplate advertises pathParams and the template', () => {
  const x402 = new X402({ secret: 's' });
  const block = x402._bazaarBlock({
    id: 'price', price: 1000, method: 'GET', routeTemplate: '/api/price/:mint',
    inputSchema: { mint: 'Solana mint address' },
    inputExample: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
    outputSchema: { type: 'object', properties: { price_usd: { type: 'number' } } }
  });
  assert.deepStrictEqual(block.info.input.pathParams, { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' });
  assert.strictEqual(block.info.input.queryParams, undefined);
  assert.strictEqual(block.routeTemplate, '/api/price/:mint');
  assert.deepStrictEqual(block.schema.properties.input.required, ['type', 'method', 'pathParams']);
});

console.log('\n' + passed + ' passed');
