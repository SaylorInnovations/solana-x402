// Example: gate an Express route behind x402 payment.
'use strict';
const express = require('express');
const { X402 } = require('solana-x402');

const app = express();
const x402 = new X402({
  payTo: process.env.SOLANA_PAY_TO,
  secret: process.env.X402_SECRET,
  rpcUrl: process.env.HELIUS_RPC
});

const RESOURCE = { id: 'weather', title: 'Current weather', price: 1000 }; // $0.001

app.get('/weather', async (req, res) => {
  const resourceUrl = req.protocol + '://' + req.get('host') + req.originalUrl;
  const payment = x402.readPayment(req.headers);

  if (!payment) {
    const body = await x402.paymentRequired(RESOURCE, resourceUrl);
    return res.status(402).json(body);
  }

  const result = await x402.settle(payment, RESOURCE, resourceUrl);
  if (!result.ok) {
    const body = await x402.paymentRequired(RESOURCE, resourceUrl, result.reason);
    return res.status(402).json(body);
  }

  res.set('X-Payment-Response', x402.settlementHeader(result.signature, result.amount, result.asset));
  res.json({ temperature: 72, conditions: 'sunny' });
});

app.listen(3000, () => console.log('listening on :3000'));
