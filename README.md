# solana-x402

A zero-dependency **x402** (HTTP 402 Payment Required) resource server for **Solana**, with optional facilitator settlement (Coinbase CDP and/or PayAI) and automatic **CDP x402 Bazaar** discoverability.

Most x402 server SDKs assume you'll route every payment through a facilitator. This one doesn't make you: Solana payments can be **self-verified** — diffed straight off Solana RPC pre/post balances — so you can accept USDC, USDT, or native SOL with **no facilitator, no facilitator fee, and no third-party account**. Facilitator settlement (needed for stock x402 clients that send a partially-signed transaction, and for Base/EVM) is layered on top as an option, not a requirement.

Built and battle-tested in production at [saylorinnovations.com](https://saylorinnovations.com) — real Solana and Base payments settled, both self-verified and facilitator-routed.

## Why this exists

- **No facilitator required for Solana.** The self-verify path costs you nothing but an RPC call (Helius, or any Solana RPC).
- **Zero runtime dependencies.** Just Node's built-in `crypto` and `fetch`.
- **Facilitator settlement when you want it** — CDP (Coinbase Developer Platform) and PayAI both supported, with automatic fallback between them.
- **CDP x402 Bazaar discoverability built in.** Give a resource an `outputSchema` and it's automatically marked discoverable — no separate registration step, no `@coinbase/x402` middleware required.
- **Base (EVM) support** alongside Solana, so one server can quote both.
- **Framework-agnostic.** Works in a Netlify Function, a Vercel Function, an Express route, or a raw `http` server — see `examples/`.

## Install

```bash
npm install solana-x402
```

## Quickstart

```js
const { X402 } = require('solana-x402');

const x402 = new X402({
  payTo: 'YOUR_SOLANA_WALLET_ADDRESS',
  secret: process.env.X402_SECRET,   // long random string — signs quote sessions
  rpcUrl: process.env.HELIUS_RPC     // enables the fee-free self-verify path
});

const resource = { id: 'my-endpoint', title: 'My paid endpoint', price: 10000 }; // atomic USDC units, 6 decimals = $0.01

// In your request handler:
const payment = x402.readPayment(req.headers);
if (!payment) {
  return res.status(402).json(await x402.paymentRequired(resource, resourceUrl));
}
const result = await x402.settle(payment, resource, resourceUrl);
if (!result.ok) {
  return res.status(402).json(await x402.paymentRequired(resource, resourceUrl, result.reason));
}
res.set('X-Payment-Response', x402.settlementHeader(result.signature, result.amount, result.asset));
res.json({ /* the thing they paid for */ });
```

See `examples/netlify-function.js` and `examples/express.js` for complete, runnable versions.

## How settlement works

A 402 response offers **two ways to pay**, both spec-compliant x402 v2:

1. **Facilitator-transaction** (standard, works with any stock x402 client library): the client sends `payload.transaction` — a base64 partially-signed transaction — plus which `accepts[]` entry it's using. This library forwards it to a facilitator's `/verify` and `/settle`. When CDP credentials are configured, CDP is tried first (and is the one that can catalog the resource into the Bazaar); PayAI is the fallback, used automatically if CDP isn't configured or a call to it transport-fails.
2. **Self-submitted reference** (Solana only, no facilitator): the client submits its own SPL transfer or native SOL transfer directly, including a `reference` public key as a read-only account (Solana Pay style), then retries with `X-PAYMENT` carrying `{session, reference}`. This library verifies the payment itself by diffing pre/post balances at that reference over Solana RPC — no third party ever sees the transaction.

Every quote — either path — is bound to a fresh, single-use `reference` and an HMAC-signed `session` carrying the mint and minimum amount, so a payment can't be replayed against a different quote.

## CDP Bazaar discoverability

Give any resource an `outputSchema` (plain JSON Schema) and it's automatically marked `discoverable: true` for the [x402 Bazaar](https://docs.cdp.coinbase.com/x402/core-concepts/bazaar) whenever it settles through CDP:

```js
const resource = {
  id: 'token-price',
  title: 'Live token price',
  price: 1000,
  outputSchema: {
    type: 'object',
    properties: { price_usd: { type: 'number' } }
  },
  inputSchema: { mint: 'Token mint address' },
  category: 'Data',
  tags: ['crypto', 'price']
};
```

Opt a specific resource out with `resource.bazaar = false`, or pass a fully custom block via `resource.bazaar = { discoverable: true, ... }`.

## API

### `new X402(opts)`

| Option | Required | Description |
|---|---|---|
| `secret` | yes | HMAC secret for signing quote sessions. Use a long random value. |
| `payTo` | for Solana | Your Solana wallet address (base58). |
| `evmPayTo` | for Base | Your Base/EVM wallet address (`0x...`). |
| `rpcUrl` | for self-verify | Solana RPC URL (Helius etc.). Required for the fee-free settlement path. |
| `maxTimeoutSeconds` | no | Quote validity window. Default `120`. |
| `payai` | no | `{ url }` — override the PayAI (or any generic x402 facilitator) endpoint. |
| `cdp` | no | `{ keyId, keySecret }` — CDP API key. Enables CDP facilitator settlement + Bazaar listing. |

### `resource` shape

`{ id, title, price, description?, mimeType?, license?, tokenCount?, inputSchema?, outputSchema?, method?, freeSample?, category?, tags?, bazaar? }`

`price` is in atomic USDC units (6 decimals) — `10000` = $0.01.

### Methods

- `await x402.paymentRequired(resource, resourceUrl, error?)` → the x402 v2 `PaymentRequired` body (plain object).
- `await x402.paymentRequiredResponse(resource, resourceUrl, error?)` → the same, wrapped as `{statusCode: 402, headers, body}`.
- `x402.readPayment(headers)` → parses `X-PAYMENT` (or `Payment-Signature`) off request headers, or `null`.
- `await x402.settle(payment, resource, resourceUrl)` → `{ok: true, signature, amount, asset, payer, via}` or `{ok: false, reason}`.
- `x402.settlementHeader(signature, amount, asset)` → the `X-PAYMENT-RESPONSE` header value for a `200`.

## Getting a CDP API key (optional)

CDP facilitator settlement and Bazaar listing need a Coinbase Developer Platform API key. The **non-custodial API tier** — which is all this library uses — is available immediately on signup, with no business verification required (that's only needed for custodial features like live payouts):

1. Create an account at [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com).
2. Go to **API Keys → Secret API Keys → Create API key** (leave the algorithm as the default, Ed25519).
3. Set `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` from the downloaded key.

If you skip this, the library still works fully — facilitator settlement falls back to PayAI automatically, and self-verified Solana settlement never needed a facilitator in the first place.

## Testing

```bash
npm test
```

Runs an offline smoke suite (no network calls) covering the crypto primitives and request parsing. Live settlement is exercised against a real deployment — see `examples/`.

## License

MIT
