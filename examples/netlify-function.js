// Example: gate a Netlify Function behind x402 payment.
// Deploy this as netlify/functions/premium-data.js and route
// /api/premium-data -> it, in netlify.toml.
'use strict';
const { X402 } = require('solana-x402');

const x402 = new X402({
  payTo: process.env.SOLANA_PAY_TO,           // your Solana wallet, base58
  evmPayTo: process.env.BASE_PAY_TO,          // optional — your Base/EVM wallet, 0x...
  secret: process.env.X402_SECRET,            // long random string, keep it in env vars
  rpcUrl: process.env.HELIUS_RPC,             // Solana RPC — enables the fee-free self-verify path
  cdp: process.env.CDP_API_KEY_ID ? {         // optional — enables CDP facilitator + Bazaar listing
    keyId: process.env.CDP_API_KEY_ID,
    keySecret: process.env.CDP_API_KEY_SECRET
  } : undefined
});

const RESOURCE = {
  id: 'premium-data',
  title: 'Premium market data',
  price: 10000, // atomic USDC units, 6 decimals -> $0.01
  mimeType: 'application/json',
  outputSchema: { type: 'object', properties: { value: { type: 'number' } } } // present -> listed in the CDP Bazaar
};

exports.handler = async (event) => {
  const resourceUrl = 'https://your-domain.example/api/premium-data';

  const payment = x402.readPayment(event.headers);
  if (!payment) return x402.paymentRequiredResponse(RESOURCE, resourceUrl);

  const result = await x402.settle(payment, RESOURCE, resourceUrl);
  if (!result.ok) return x402.paymentRequiredResponse(RESOURCE, resourceUrl, result.reason);

  return {
    statusCode: 200,
    headers: {
      'content-type': 'application/json',
      'x-payment-response': x402.settlementHeader(result.signature, result.amount, result.asset)
    },
    body: JSON.stringify({ value: 42 })
  };
};
