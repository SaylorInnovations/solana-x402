// Shared payment primitives: base58 (for Solana Pay `reference` keys),
// stateless HMAC-signed tokens (replay-protected quote sessions), and
// self-verified settlement over raw Helius/Solana JSON-RPC.
//
// Zero dependencies — everything here is Node's built-in `crypto` plus fetch.
'use strict';

const crypto = require('crypto');

// ---- base58 ----
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let str = '1'.repeat(zeros);
  for (let k = digits.length - 1; k >= 0; k--) str += B58[digits[k]];
  return str;
}
function newReference() { return b58encode(crypto.randomBytes(32)); }

// ---- stateless HMAC tokens ----
function sign(obj, secret) {
  const p = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const s = crypto.createHmac('sha256', secret).update(p).digest('base64url');
  return p + '.' + s;
}
function verifyToken(tok, secret) {
  if (!tok || tok.indexOf('.') < 0) return null;
  const [p, s] = tok.split('.');
  const s2 = crypto.createHmac('sha256', secret).update(p).digest('base64url');
  const a = Buffer.from(s), b = Buffer.from(s2);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let obj; try { obj = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch (e) { return null; }
  if (obj.exp && Date.now() > obj.exp) return null;
  return obj;
}

// ---- self-verified settlement over Helius/Solana JSON-RPC ----
async function rpcCall(rpcUrl, method, params) {
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}

// Look for a confirmed payment to `recipient` of >= minAmount (base units).
// mint = SPL mint address for stablecoins, or null for native SOL.
// Provide `reference` (Solana Pay ref key) OR an explicit `signature`.
async function findPayment(rpcUrl, { reference, signature, recipient, mint, minAmount }) {
  if (!rpcUrl) return { ok: false, reason: 'no RPC URL configured' };
  let sigs = [];
  if (signature) sigs = [{ signature }];
  else sigs = await rpcCall(rpcUrl, 'getSignaturesForAddress', [reference, { limit: 12 }]);

  for (const si of sigs) {
    if (si.confirmationStatus === 'processed') continue; // want confirmed/finalized
    const tx = await rpcCall(rpcUrl, 'getTransaction', [si.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
    if (!tx || !tx.meta || tx.meta.err) continue;

    if (mint) {
      const pre = tx.meta.preTokenBalances || [], post = tx.meta.postTokenBalances || [];
      const k = x => x.owner + '|' + x.mint;
      const preMap = {}; pre.forEach(x => { preMap[k(x)] = Number(x.uiTokenAmount.amount); });
      for (const x of post) {
        if (x.owner === recipient && x.mint === mint) {
          const delta = Number(x.uiTokenAmount.amount) - (preMap[k(x)] || 0);
          if (delta >= minAmount) return { ok: true, signature: si.signature };
        }
      }
    } else {
      const keys = (tx.transaction.message.accountKeys || []).map(a => (typeof a === 'string' ? a : a.pubkey));
      const idx = keys.indexOf(recipient);
      if (idx >= 0) {
        const delta = tx.meta.postBalances[idx] - tx.meta.preBalances[idx];
        if (delta >= minAmount) return { ok: true, signature: si.signature };
      }
    }
  }
  return { ok: false, reason: 'payment not found on-chain yet' };
}

module.exports = { b58encode, newReference, sign, verifyToken, findPayment };
