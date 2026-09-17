# Agent buyer quickstart

Saylor Innovations publishes a live x402 resource catalog for agents at
[`agents.saylorinnovations.com`](https://agents.saylorinnovations.com/).

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
