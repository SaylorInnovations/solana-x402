import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';

if (!process.env.EVM_PRIVATE_KEY) {
  throw new Error('Set EVM_PRIVATE_KEY in the environment; never commit a private key.');
}

const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY);
const client = new x402Client();
client.register('eip155:*', new ExactEvmScheme(account));

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const response = await fetchWithPayment(
  'https://saylorinnovations.com/api/price/So11111111111111111111111111111111111111112'
);

if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
console.log(JSON.stringify(await response.json(), null, 2));
