// x402 v2 resource-server core: Solana self-verified settlement (no
// facilitator, no fee) plus optional facilitator-transaction settlement
// (CDP and/or PayAI) for stock x402 clients and CDP Bazaar discoverability.
//
// Zero dependencies. Framework-agnostic — this module builds plain objects
// ({statusCode, headers, body}-shaped where useful, but you can also just use
// the raw building blocks) that you return from whatever handler your runtime
// uses (Netlify Function, Vercel Function, Express route, raw http server).
'use strict';

const crypto = require('crypto');
const Pay = require('./pay.js');

const X402_VERSION = 2;

// Dollar-pegged SPL stablecoins on Solana mainnet — fixed protocol facts, not
// configurable. Add another 1:1 stablecoin here if you need one.
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // 6 decimals
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'; // 6 decimals
const STABLES = [USDC, USDT];
const WSOL = 'So11111111111111111111111111111111111111112'; // identifies native SOL — x402 `asset` wants a mint and SOL has none
const SOL_TOLERANCE = 0.97; // accept 3% under a live quote — price moves between quote and settle
const PRICE_TTL = 60000;

const NET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const NET_LEGACY = 'solana';
const BASE_CAIP2 = 'eip155:8453';
const BASE_LEGACY = 'base';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_NETWORKS = [BASE_CAIP2, BASE_LEGACY];

const CDP_HOST = 'api.cdp.coinbase.com';
const CDP_PREFIX = '/platform/v2/x402';
const CDP_BASE = 'https://' + CDP_HOST + CDP_PREFIX;
const DEFAULT_PAYAI = 'https://facilitator.payai.network';
const FACILITATOR_TIMEOUT = 15000;

function b64(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64'); }
function unb64(s) { try { return JSON.parse(Buffer.from(String(s), 'base64').toString('utf8')); } catch (e) { return null; } }

class X402 {
  /**
   * @param {object} opts
   * @param {string} opts.payTo - Solana recipient address (base58). Required to accept Solana payments.
   * @param {string} [opts.evmPayTo] - Base/EVM recipient address (0x...). Required to accept Base payments.
   * @param {string} opts.secret - HMAC secret for signing quote sessions. Use a long random value in production.
   * @param {string} [opts.rpcUrl] - Solana RPC URL (Helius etc.). Required for the self-verify settlement path.
   * @param {number} [opts.maxTimeoutSeconds=120] - How long a quote is valid before it expires.
   * @param {{url?: string}} [opts.payai] - PayAI (or any generic x402 facilitator) config. Defaults to PayAI's public endpoint.
   * @param {{keyId: string, keySecret: string}} [opts.cdp] - Coinbase Developer Platform facilitator credentials.
   *   When set, facilitator-transaction settlement prefers CDP over PayAI, and resources with an
   *   outputSchema are marked discoverable in the CDP x402 Bazaar.
   */
  constructor(opts) {
    if (!opts || !opts.secret) throw new Error('solana-x402: opts.secret is required');
    this.payTo = opts.payTo || null;
    this.evmPayTo = opts.evmPayTo || null;
    this.secret = opts.secret;
    this.rpcUrl = opts.rpcUrl || null;
    this.maxTimeoutSeconds = opts.maxTimeoutSeconds || 120;
    this.quoteTtlMs = this.maxTimeoutSeconds * 1000;
    this.payaiUrl = (opts.payai && opts.payai.url) || DEFAULT_PAYAI;
    this.cdpKeyId = (opts.cdp && opts.cdp.keyId) || null;
    this.cdpKeySecret = (opts.cdp && opts.cdp.keySecret) || null;
    this.cdpEnabled = !!(this.cdpKeyId && this.cdpKeySecret);
    this._cdpPrivateKey = null;
    this._feePayerCache = { v: null, at: 0 };
    this._priceCache = { usd: null, at: 0 };
  }

  // ---- CDP auth: a fresh Ed25519 JWT per request (120s TTL) ----
  _cdpKey() {
    if (this._cdpPrivateKey || !this.cdpKeySecret) return this._cdpPrivateKey;
    const raw = Buffer.from(this.cdpKeySecret, 'base64'); // 64 bytes: 32-byte seed + 32-byte public key
    const jwk = { kty: 'OKP', crv: 'Ed25519', d: raw.subarray(0, 32).toString('base64url'), x: raw.subarray(32, 64).toString('base64url') };
    this._cdpPrivateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
    return this._cdpPrivateKey;
  }
  _cdpJwt(method, shortPath) {
    const key = this._cdpKey();
    if (!key) return null;
    const header = { alg: 'EdDSA', typ: 'JWT', kid: this.cdpKeyId, nonce: crypto.randomBytes(8).toString('hex') };
    const now = Math.floor(Date.now() / 1000);
    const claims = { sub: this.cdpKeyId, iss: 'cdp', aud: ['cdp_service'], nbf: now, exp: now + 120, uri: method + ' ' + CDP_HOST + CDP_PREFIX + shortPath };
    const h = Buffer.from(JSON.stringify(header)).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signingInput = h + '.' + p;
    const sig = crypto.sign(null, Buffer.from(signingInput), key).toString('base64url');
    return signingInput + '.' + sig;
  }
  async _cdpCall(shortPath, paymentPayload, paymentRequirements) {
    const jwt = this._cdpJwt('POST', shortPath);
    if (!jwt) return { httpOk: false, status: 0, raw: 'CDP credentials not configured' };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), FACILITATOR_TIMEOUT);
    try {
      const r = await fetch(CDP_BASE + shortPath, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + jwt },
        signal: ctl.signal, body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload, paymentRequirements })
      });
      const text = await r.text();
      let j = null; try { j = JSON.parse(text); } catch (e) { /* non-JSON body */ }
      return { httpOk: r.ok, status: r.status, body: j, raw: text.slice(0, 300), extRes: r.headers.get('extension-responses') };
    } catch (e) {
      return { httpOk: false, status: 0, raw: e.name === 'AbortError' ? 'CDP timeout' : String(e.message || e) };
    } finally { clearTimeout(t); }
  }

  async _payaiCall(path, paymentPayload, paymentRequirements) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), FACILITATOR_TIMEOUT);
    try {
      const r = await fetch(this.payaiUrl.replace(/\/+$/, '') + path, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
        body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload, paymentRequirements })
      });
      const text = await r.text();
      let j = null; try { j = JSON.parse(text); } catch (e) { /* non-JSON body */ }
      return { httpOk: r.ok, status: r.status, body: j, raw: text.slice(0, 300) };
    } catch (e) {
      return { httpOk: false, status: 0, raw: e.name === 'AbortError' ? 'facilitator timeout' : String(e.message || e) };
    } finally { clearTimeout(t); }
  }

  // Try CDP first when configured (it's the one that catalogs into the x402
  // Bazaar); fall back to PayAI only on a transport failure. An authoritative
  // error response from CDP (a real 400/402) is never retried against PayAI.
  async _anyFacilitatorCall(path, paymentPayload, paymentRequirements) {
    if (this.cdpEnabled) {
      const r = await this._cdpCall(path, paymentPayload, paymentRequirements);
      if (r.status !== 0) return Object.assign(r, { via: 'cdp' });
    }
    const r2 = await this._payaiCall(path, paymentPayload, paymentRequirements);
    return Object.assign(r2, { via: 'payai' });
  }

  async _feePayer() {
    if (this._feePayerCache.v && Date.now() - this._feePayerCache.at < 3600000) return this._feePayerCache.v;
    if (this.cdpEnabled) {
      try {
        const jwt = this._cdpJwt('GET', '/supported');
        const r = await fetch(CDP_BASE + '/supported', { headers: { authorization: 'Bearer ' + jwt } });
        const j = await r.json();
        const arr = Array.isArray(j.kinds) ? j.kinds : [];
        const hit = arr.find(k => k.network === NET_CAIP2 && k.scheme === 'exact' && k.x402Version === 2 && k.extra && k.extra.feePayer);
        if (hit) { this._feePayerCache = { v: hit.extra.feePayer, at: Date.now() }; return hit.extra.feePayer; }
      } catch (e) { /* fall through to PayAI */ }
    }
    try {
      const r = await fetch(this.payaiUrl.replace(/\/+$/, '') + '/supported');
      const j = await r.json();
      const arr = Array.isArray(j.kinds) ? j.kinds : [];
      const hit = arr.find(k => String(k.network || '').startsWith('solana') && k.extra && k.extra.feePayer);
      if (hit) { this._feePayerCache = { v: hit.extra.feePayer, at: Date.now() }; return hit.extra.feePayer; }
    } catch (e) { /* advertise nothing rather than something wrong */ }
    return null;
  }

  async _solPriceUsd() {
    if (this._priceCache.usd && Date.now() - this._priceCache.at < PRICE_TTL) return this._priceCache.usd;
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      const j = await r.json();
      const p = j && j.solana && j.solana.usd;
      if (p) { this._priceCache = { usd: p, at: Date.now() }; return p; }
    } catch (e) { /* fall through — caller degrades to USDC-only */ }
    return null;
  }

  _assetEntries(resource, asset, atomicAmount, mint, extraFields, feePayer) {
    const reference = Pay.newReference();
    const session = Pay.sign({ id: resource.id, reference, recipient: this.payTo, mint, minAmount: atomicAmount, exp: Date.now() + this.quoteTtlMs }, this.secret);
    const extra = Object.assign({ reference, session, memo: 'x402:' + resource.id }, extraFields || {});
    if (feePayer) extra.feePayer = feePayer;
    const base = { scheme: 'exact', amount: String(atomicAmount), asset, payTo: this.payTo, maxTimeoutSeconds: this.maxTimeoutSeconds, extra };
    return [Object.assign({ network: NET_CAIP2 }, base), Object.assign({ network: NET_LEGACY }, base)];
  }

  _baseEntries(resource) {
    if (!this.evmPayTo) return [];
    const base = {
      scheme: 'exact', amount: String(resource.price), asset: BASE_USDC, payTo: this.evmPayTo, maxTimeoutSeconds: this.maxTimeoutSeconds,
      extra: { facilitatorOnly: true, memo: 'x402:' + resource.id, note: 'Base settles through an x402 facilitator. Send payload.transaction (EIP-3009 authorization); there is no self-submitted path on this network.' }
    };
    return BASE_NETWORKS.map(network => Object.assign({ network }, base));
  }

  // Auto-derive a Bazaar discoverability block from resource.outputSchema
  // unless the caller supplied resource.bazaar explicitly (including `false`
  // to opt a specific resource out, or a full custom {info, schema} object).
  //
  // Shape and placement per the x402 bazaar extension spec
  // (github.com/coinbase/x402 specs/extensions/bazaar.md): an {info, schema}
  // object, attached to paymentPayload.extensions.bazaar in settle() below --
  // NOT paymentRequirements.extensions, and NOT the flatter
  // {discoverable, category, tags, inputSchema, outputSchema} shape this used
  // to build through v0.1.0. Both were wrong and verified as such against a
  // real CDP account: that shape/location produced an empty EXTENSION-
  // RESPONSES ({}) on every real settlement -- nothing was ever actually
  // catalogued. The corrected shape below gets a real "processing"/
  // "rejected" response, confirmed with 10 separate real payments against a
  // live deployment (saylorinnovations.com's Watchdog API).
  //
  // resource.inputSchema keys become an example params object. Set
  // resource.routeTemplate (e.g. '/api/price/:mint') if your route has a
  // path parameter -- the params are then advertised as info.input.pathParams
  // and grouped under that one catalog entry, per the spec's "Dynamic
  // Routes" mechanism. Without a routeTemplate, params are advertised as
  // ordinary queryParams instead (the safer default for a generic library
  // that doesn't otherwise know your routing).
  _bazaarBlock(resource) {
    if (resource.bazaar === false) return null;
    if (resource.bazaar) return resource.bazaar;
    if (!resource.outputSchema) return null;

    const inputKeys = Object.keys(resource.inputSchema || {});
    const example = inputKeys.length
      ? Object.fromEntries(inputKeys.map(k => [k, (resource.inputExample && resource.inputExample[k]) || k]))
      : null;
    const paramsKey = resource.routeTemplate ? 'pathParams' : 'queryParams';

    const input = Object.assign({ type: 'http', method: resource.method || 'GET' }, example ? { [paramsKey]: example } : {});
    const inputProps = {
      type: { type: 'string', const: 'http' },
      method: { type: 'string', enum: ['GET', 'HEAD', 'DELETE'] }
    };
    const required = ['type', 'method'];
    if (example) {
      inputProps[paramsKey] = { type: 'object', properties: Object.fromEntries(inputKeys.map(k => [k, { type: 'string' }])), required: inputKeys };
      required.push(paramsKey);
    }
    const block = {
      info: { input, output: { type: 'json' } },
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          input: { type: 'object', properties: inputProps, required, additionalProperties: false },
          output: { type: 'object', properties: { type: { type: 'string' } }, required: ['type'] }
        },
        required: ['input']
      }
    };
    if (resource.routeTemplate) block.routeTemplate = resource.routeTemplate;
    return block;
  }

  /**
   * Build the full x402 v2 PaymentRequired body for a resource.
   * @param {object} resource - {id, title, description?, price (atomic USDC units), license?, mimeType?, inputSchema?, outputSchema?, tags?, category?, bazaar?}
   * @param {string} resourceUrl - the canonical URL of this resource (echoed back to clients and facilitators)
   * @param {string} [error] - human-readable reason, e.g. why a retry was rejected
   */
  async paymentRequired(resource, resourceUrl, error) {
    const accepts = [];
    if (this.payTo) {
      const feePayer = await this._feePayer();
      const svmExtra = feePayer ? {} : {}; // feePayer is merged in by _assetEntries below
      for (const mint of STABLES) accepts.push(...this._assetEntries(resource, mint, resource.price, mint, svmExtra, feePayer));
    }
    accepts.push(...this._baseEntries(resource));
    if (this.payTo) {
      const px = await this._solPriceUsd();
      if (px) {
        const usd = resource.price / 1e6;
        const lamports = Math.floor((usd / px) * 1e9);
        const minLamports = Math.floor(lamports * SOL_TOLERANCE);
        if (lamports > 0) {
          const feePayer = await this._feePayer();
          accepts.push(...this._assetEntries(resource, WSOL, minLamports, null, {
            native: true, quotedLamports: String(lamports), solUsdPrice: px,
            note: 'Native SOL: send lamports with a system transfer, not an SPL transfer. Price is quoted live and this quote expires in ' + this.maxTimeoutSeconds + 's.'
          }, feePayer));
        }
      }
    }

    const bazaar = this._bazaarBlock(resource);
    return {
      x402Version: X402_VERSION,
      error: error || 'Payment required to unlock this resource.',
      resource: { url: resourceUrl, description: resource.title || resource.id, mimeType: resource.mimeType || 'application/json' },
      accepts,
      extensions: Object.assign(
        {
          license: resource.license,
          tokenCount: resource.tokenCount,
          settlementModes: ['facilitator-transaction', 'self-submitted-reference'],
          instructions: 'STANDARD PATH (works with stock x402 clients): send payload.transaction plus the chosen accepts entry as "accepted" — settled through a facilitator. ALTERNATIVE PATH (no facilitator, Solana only): pick ONE accepts entry, submit your own transfer including extra.reference as a read-only account, then retry with X-PAYMENT: base64({x402Version:2, payload:{session, reference}}). Settlement is not instant — retry a few times over 10-20s.'
        },
        resource.outputSchema ? { inputSchema: resource.inputSchema, outputSchema: resource.outputSchema, method: resource.method, freeSample: resource.freeSample } : {},
        bazaar ? {} : {}
      )
    };
  }

  /** Convenience: the full {statusCode, headers, body} 402 HTTP response. */
  async paymentRequiredResponse(resource, resourceUrl, error) {
    return {
      statusCode: 402,
      headers: {
        'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*'
      },
      body: JSON.stringify(await this.paymentRequired(resource, resourceUrl, error))
    };
  }

  /** Pull the client's PaymentPayload out of request headers (case-insensitive). */
  readPayment(headers) {
    const h = headers || {};
    const raw = h['x-payment'] || h['X-PAYMENT'] || h['payment-signature'] || h['PAYMENT-SIGNATURE'];
    if (!raw) return null;
    const decoded = unb64(raw);
    if (decoded) return decoded;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  async _authorizedTerms(resource, network, asset) {
    const net = String(network || NET_CAIP2).toLowerCase();
    const isBase = BASE_NETWORKS.includes(net);
    if (isBase) {
      if (!this.evmPayTo || String(asset).toLowerCase() !== BASE_USDC.toLowerCase()) return null;
      return { payTo: this.evmPayTo, minAmount: resource.price, caseInsensitive: true };
    }
    if (!this.payTo) return null;
    if (STABLES.includes(asset)) return { payTo: this.payTo, minAmount: resource.price };
    if (asset === WSOL) {
      const px = await this._solPriceUsd();
      if (!px) return null;
      return { payTo: this.payTo, minAmount: Math.floor(((resource.price / 1e6) / px) * 1e9 * SOL_TOLERANCE) };
    }
    return null;
  }

  /**
   * Verify a client actually paid, settling however the payload indicates.
   * Returns {ok, signature, amount, asset, payer, via} or {ok:false, reason}.
   */
  async settle(payment, resource, resourceUrl) {
    const pl = (payment && (payment.payload || payment)) || {};

    // ---- Canonical exact-svm/exact-evm: client sent a partially-signed
    // transaction for a facilitator to sponsor and submit. ----
    if (pl.transaction) {
      const acc = (payment && payment.accepted) || {};
      const network = acc.network || NET_CAIP2;
      const asset = acc.asset || USDC;
      const terms = await this._authorizedTerms(resource, network, asset);
      if (!terms) return { ok: false, reason: 'unsupported or unpriceable asset ' + asset + ' on network ' + network };
      if (acc.payTo) {
        const a = terms.caseInsensitive ? String(acc.payTo).toLowerCase() : acc.payTo;
        const b = terms.caseInsensitive ? terms.payTo.toLowerCase() : terms.payTo;
        if (a !== b) return { ok: false, reason: 'payTo does not match this resource server' };
      }
      if (acc.amount !== undefined && Number(acc.amount) < terms.minAmount) return { ok: false, reason: 'quoted amount below the price for this resource' };

      const requirements = {
        scheme: 'exact', network, amount: String(terms.minAmount), asset, payTo: terms.payTo, maxTimeoutSeconds: this.maxTimeoutSeconds,
        description: resource.title || resource.id, mimeType: resource.mimeType || 'application/json'
      };
      // extra.feePayer is REQUIRED by the exact-svm scheme -- without it a
      // facilitator can't tell a client who the fee payer is, and CDP
      // rejects paymentRequirements missing it as invalid_payload. Re-derive
      // via the same _feePayer() the 402 quote used, so the advertised fee
      // payer always matches whichever facilitator actually settles this.
      const feePayer = await this._feePayer();
      if (feePayer) requirements.extra = { feePayer };

      const payload = Object.assign({}, payment);
      if (!payload.resource && resourceUrl) payload.resource = { url: resourceUrl, description: resource.title || resource.id, mimeType: resource.mimeType || 'application/json' };
      // Bazaar discovery extension -- see _bazaarBlock() for shape/placement
      // details. Belongs on payload.extensions, not requirements.extensions.
      const bazaar = this._bazaarBlock(resource);
      if (bazaar) payload.extensions = Object.assign({}, payload.extensions, { bazaar });

      const v = await this._anyFacilitatorCall('/verify', payload, requirements);
      const vb = v.body || {};
      if (!(vb.isValid === true || vb.valid === true)) {
        const why = vb.invalidReason || vb.errorReason || vb.error || v.raw || 'facilitator rejected the payment';
        return { ok: false, reason: 'facilitator verify failed: ' + why };
      }
      const s = await this._anyFacilitatorCall('/settle', payload, requirements);
      const sb = s.body || {};
      if (sb.success !== true) {
        const why = sb.errorReason || sb.error || s.raw || 'settlement failed';
        return { ok: false, reason: 'facilitator settle failed: ' + why };
      }
      return { ok: true, signature: sb.transaction || sb.txHash || sb.signature || null, amount: terms.minAmount, asset, payer: sb.payer || null, via: s.via };
    }

    // ---- Self-submitted reference: no facilitator, agent paid directly. ----
    if (pl.session) {
      const sess = Pay.verifyToken(pl.session, this.secret);
      if (!sess) return { ok: false, reason: 'invalid or expired payment quote' };
      if (sess.id !== resource.id) return { ok: false, reason: 'quote is for a different resource' };
      if (pl.reference && pl.reference !== sess.reference) return { ok: false, reason: 'reference mismatch' };
      const res = await Pay.findPayment(this.rpcUrl, { reference: sess.reference, signature: pl.signature, recipient: sess.recipient, mint: sess.mint, minAmount: sess.minAmount });
      return res.ok ? { ok: true, signature: res.signature, amount: sess.minAmount, asset: sess.mint || WSOL, via: 'self-verify' } : { ok: false, reason: res.reason || 'payment not found on-chain yet' };
    }

    // ---- Signature-only fallback: USDC only, no replay protection. ----
    if (pl.signature) {
      if (!this.payTo) return { ok: false, reason: 'payments not configured' };
      const res = await Pay.findPayment(this.rpcUrl, { signature: pl.signature, recipient: this.payTo, mint: USDC, minAmount: resource.price });
      return res.ok ? { ok: true, signature: res.signature, amount: resource.price, asset: USDC, via: 'self-verify' } : { ok: false, reason: 'payment not found for that signature' };
    }

    return { ok: false, reason: 'X-PAYMENT carried no transaction, session, or signature' };
  }

  /** X-PAYMENT-RESPONSE header value for a successful settlement. */
  settlementHeader(signature, amount, asset) {
    return b64({ success: true, transaction: signature, network: NET_CAIP2, payer: null, amount: String(amount), asset: asset || USDC });
  }
}

module.exports = {
  X402, X402_VERSION, USDC, USDT, STABLES, WSOL, NET_CAIP2, NET_LEGACY,
  BASE_CAIP2, BASE_LEGACY, BASE_USDC, BASE_NETWORKS
};
