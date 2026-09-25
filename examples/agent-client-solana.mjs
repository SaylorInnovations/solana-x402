// Pay for one Saylor Innovations x402 call with Solana USDC and print the result.
//
//   npm install @x402/fetch @x402/svm @solana/kit bs58
//   SOLANA_PRIVATE_KEY=<base58 secret key> node agent-client-solana.mjs [url]
//
// Default call: Solana token rug-risk report ($0.01). Try it free first:
//   curl https://saylorinnovations.com/api/sample/security
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import bs58 from 'bs58';

if (!process.env.SOLANA_PRIVATE_KEY) {
  throw new Error('Set SOLANA_PRIVATE_KEY (base58) in the environment; never commit a private key.');
}

const signer = await createKeyPairSignerFromBytes(bs58.decode(process.env.SOLANA_PRIVATE_KEY));
const client = new x402Client();
client.register('solana:*', new ExactSvmScheme(signer));

const url = process.argv[2] ||
  'https://saylorinnovations.com/api/security/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const response = await wrapFetchWithPayment(fetch, client)(url);

if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
console.log(JSON.stringify(await response.json(), null, 2));
