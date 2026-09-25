# Agent buyer quickstart

Saylor Innovations publishes a live x402 resource catalog for agents at
[`agents.saylorinnovations.com`](https://agents.saylorinnovations.com/).

## Try it in one minute

**1. Free sample (no wallet, no key).** Every paid endpoint lists a `sampleUrl` in the
[manifest](https://saylorinnovations.com/.well-known/x402.json): a real response to its example call.

```bash
curl https://saylorinnovations.com/api/sample/security      # Solana token rug-risk report
curl https://saylorinnovations.com/api/sample/holders       # holder concentration
curl https://saylorinnovations.com/samples/predictions-search.json   # Polymarket + Kalshi odds
```

**2. Paid call (Solana USDC, $0.01).** Tested end to end against the live API:

```bash
npm install @x402/fetch @x402/svm @solana/kit bs58
SOLANA_PRIVATE_KEY=<base58 secret> node examples/agent-client-solana.mjs
```

See [`examples/agent-client-solana.mjs`](examples/agent-client-solana.mjs). Paying with Base,
Polygon or Arbitrum USDC instead: [`examples/agent-client.mjs`](examples/agent-client.mjs).

**Common tasks**

| Task | Paid endpoint | Price | Free sample |
|---|---|---|---|
| Solana token rug risk / is this token safe | `/api/security/{mint}` | $0.01 | [/api/sample/security](https://saylorinnovations.com/api/sample/security) |
| Check holder concentration | `/api/holders/{mint}` | $0.01 | [/api/sample/holders](https://saylorinnovations.com/api/sample/holders) |
| Solana token price + liquidity | `/api/price/{mint}` | $0.001 | [/api/sample/price](https://saylorinnovations.com/api/sample/price) |
| Solana wallet analysis | `/api/wallet/{address}` | $0.01 | [/api/sample/wallet](https://saylorinnovations.com/api/sample/wallet) |
| Token price on 25 chains | `/api/token-price/{chain}/{address}` | $0.001 | [sample](https://saylorinnovations.com/samples/token-price-chain-address.json) |
| ERC-20 balance (Base, Ethereum, …) | `/api/evm/{chain}/balance/{wallet}?tokens=` | $0.003 | [sample](https://saylorinnovations.com/samples/evm-base-balance-wallet.json) |
| Polymarket / Kalshi odds | `/api/predictions/search?q=` | $0.003 | [sample](https://saylorinnovations.com/samples/predictions-search.json) |
| Perp funding rates | `/api/perps/funding` | $0.002 | [sample](https://saylorinnovations.com/samples/perps-funding.json) |
| OFAC sanctions wallet screening | `/api/sanctions/address/{address}` | $0.002 | [sample](https://saylorinnovations.com/samples/sanctions-address-address.json) |
| Web page to markdown | `/api/web/read?url=` | $0.005 | [sample](https://saylorinnovations.com/samples/web-read.json) |

Everything else (case law, medical codes, papers, transit, weather, …): search the catalog free with
the MCP tool `search_endpoints` at `https://saylorinnovations.com/mcp`, or
`https://saylorinnovations.com/api/search?q=`.

A call that fails upstream, or that gets an unknown or invalid input, answers 400/404/503 **before**
payment, so you are never charged for a failure.

## Discover resources

Start with these free machine-readable indexes:

- [Agent front door](https://agents.saylorinnovations.com/)
- [x402 listing](https://saylorinnovations.com/.well-known/x402-listing)
- [Full x402 manifest](https://saylorinnovations.com/.well-known/x402.json)
- [OpenAPI description](https://saylorinnovations.com/openapi.json)
- [MCP endpoint](https://saylorinnovations.com/mcp)
- [Free search](https://saylorinnovations.com/api/search?q=token)

The paid resource URLs are on `https://saylorinnovations.com/api/...`; the
`agents` host is the discovery and documentation front door. Use the
`accepts` array in each 402 response as the source of truth for the payment
network, asset, amount, and recipient.

## Use an official x402 buyer client

The official fetch wrapper handles the 402 challenge, creates a payment, and
retries the request. Keep the signer in an environment variable and never put
private keys in source control.

```bash
npm install @x402/fetch @x402/evm viem
```

```js
// examples/agent-client.mjs
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';

const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY);
const client = new x402Client();
client.register('eip155:*', new ExactEvmScheme(account));

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const response = await fetchWithPayment(
  'https://saylorinnovations.com/api/price/So11111111111111111111111111111111111111112'
);

if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
console.log(await response.json());
```

For a no-payment smoke test, use
`https://saylorinnovations.com/api/sample/price`. For Solana-native payment
flows, register the SVM scheme from the x402 SDK and choose the canonical
`solana:<genesis-hash>` network advertised by the live manifest.

## Operating guidance

- No signup or API key is required for the public resources.
- Start with the free sample and manifest before spending funds.
- Retry a settlement response for a few seconds if the facilitator is still
  processing it.
- Do not generate artificial traffic or self-pay simply to increase catalog
  volume; use the resource when it solves a real task.

The protocol references are the [x402 buyer quickstart](https://docs.x402.org/getting-started/quickstart-for-buyers)
and [Bazaar extension specification](https://github.com/x402-foundation/x402/blob/main/docs/extensions/bazaar.mdx).
