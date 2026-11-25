// Benchmark harness: fires N concurrent payments and reports per-payment timing + aggregate stats.
//
// Usage:
//   node bench-pay.js <sessions-file> <merchant-url>
//
//   sessions-file  — JSON produced by setup-bench-sessions.js
//   merchant-url   — e.g. http://localhost:3004/pay
//
// Reads config from env (same keys as agent-cli / harness .env):
//   RPC_URL, CHAIN_ID, USD8_ADDRESS (required for signing)
//   QDAY_ENV=develop  to use testnet defaults (chain 44005, tUSD8)
//
// Defaults for QDAY_ENV=develop:
//   CHAIN_ID=44005  RPC_URL=https://rpc-test.qday.info  USD8_ADDRESS=0x456569838f1d43009A91ebA4263147Afd7233483

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createPublicClient, http, keccak256, parseAbi, concatHex } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');

// ── Config ────────────────────────────────────────────────────────────────────

function loadEnvFile(dir) {
  const file = path.join(dir, '.env');
  if (!fs.existsSync(file)) return {};
  const vars = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) vars[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return vars;
}

function loadConfig() {
  const envFile = loadEnvFile(__dirname);
  const get = (key, def) => process.env[key] ?? envFile[key] ?? def;

  const env = (get('QDAY_ENV', 'local') || '').toLowerCase();
  const isDevelop = env === 'develop' || env === 'dev' || env === 'testnet';

  const chainId = parseInt(get('CHAIN_ID', isDevelop ? '44005' : '80002'), 10);
  const rpcUrl = get('RPC_URL', isDevelop
    ? 'https://rpc-test.qday.info'
    : 'https://polygon-amoy-bor-rpc.publicnode.com');
  const usd8Address = get('USD8_ADDRESS', isDevelop
    ? '0x456569838f1d43009A91ebA4263147Afd7233483'
    : '0xa9f94A4a3fC67999F3037d9A404317D46BccB0fe').toLowerCase();

  return { chainId, rpcUrl, usd8Address };
}

// ── UserOp signing (mirrors qday-payment-agent-cli/src/userop.ts exactly) ────

const VALIDATION_TYPE_PERMISSION = 0x02;
const EXECUTE_SELECTOR = 'e9ae5c53';
const EXEC_MODE_SINGLE_DEFAULT = '00'.repeat(32);
const TRANSFER_SELECTOR = 'a9059cbb';

function word(value) {
  if (value < 0n) throw new Error('cannot encode a negative word');
  const hex = value.toString(16);
  if (hex.length > 64) throw new Error('value does not fit in 32 bytes');
  return hex.padStart(64, '0');
}

function byteHex(value) {
  if (value < 0 || value > 0xff) throw new Error('not a byte');
  return value.toString(16).padStart(2, '0');
}

function hex16(value) {
  return BigInt(value).toString(16).padStart(32, '0');
}

function packAccountGasLimits(verificationGasLimit, callGasLimit) {
  return `0x${word((verificationGasLimit << 128n) | callGasLimit)}`;
}

function packGasFees(maxPriorityFeePerGas, maxFeePerGas) {
  return `0x${word((maxPriorityFeePerGas << 128n) | maxFeePerGas)}`;
}

function encodeNonce({ mode = 0, validationType, identifier, lane, sequence }) {
  const id = identifier.slice(2).padEnd(40, '0');
  if (id.length !== 40) throw new Error('identifier is longer than 20 bytes');
  const key = BigInt(`0x${byteHex(mode)}${byteHex(validationType)}${id}${lane.toString(16).padStart(4, '0')}`);
  return (key << 64n) | sequence;
}

function canonicalTransferCallData(token, payee, amount) {
  const body = [
    EXECUTE_SELECTOR,
    EXEC_MODE_SINGLE_DEFAULT,
    word(64n),
    word(120n),
    token.slice(2).toLowerCase(),
    word(0n),
    TRANSFER_SELECTOR,
    word(BigInt(payee)),
    word(amount),
    '00'.repeat(8),
  ].join('');
  const callData = `0x${body}`;
  if ((callData.length - 2) / 2 !== 228) throw new Error(`calldata must be 228 bytes, got ${(callData.length - 2) / 2}`);
  return callData;
}

function userOpHash(op, entryPoint, chainId) {
  const inner = keccak256(`0x${[
    word(BigInt(op.sender)),
    word(op.nonce),
    keccak256(op.initCode).slice(2),
    keccak256(op.callData).slice(2),
    op.accountGasLimits.slice(2),
    word(op.preVerificationGas),
    op.gasFees.slice(2),
    keccak256(op.paymasterAndData).slice(2),
  ].join('')}`);

  return keccak256(`0x${[inner.slice(2), word(BigInt(entryPoint)), word(BigInt(chainId))].join('')}`);
}

function encodePermissionSignature(sig) {
  return concatHex(['0xff', sig]);
}

// ── honestFees (mirrors bundler.ts) ──────────────────────────────────────────

async function honestFees(chain, tipWei = 1n) {
  const block = await chain.getBlock({ blockTag: 'latest' });
  const base = block.baseFeePerGas ?? 0n;
  return { maxFeePerGas: base * 2n + tipWei, maxPriorityFeePerGas: tipWei };
}

// ── x402 merchant HTTP (mirrors merchant.ts) ──────────────────────────────────

function encodeHeader(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function decodeHeader(header) {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}

async function quote(url) {
  const response = await fetch(url, { headers: { accept: '*/*' } });
  if (response.status !== 402) {
    return { status: response.status, body: await response.text() };
  }
  const body = await response.json();
  const terms = (body.accepts ?? []).find((o) => o.scheme === 'qday:erc4337');
  if (!terms) throw new Error(`merchant offered no qday:erc4337 terms at ${url}`);
  return { terms, body };
}

function aaTermsFrom(terms) {
  const extra = terms.extra ?? {};
  const userOp = extra.userOp ?? {};
  return {
    entryPoint: extra.entryPoint,
    policy: extra.policy,
    paymaster: extra.paymaster,
    signer: extra.signer,
    verificationGasLimit: userOp.verificationGasLimit,
    callGasLimit: userOp.callGasLimit,
    preVerificationGas: userOp.preVerificationGas,
    paymasterVerificationGasLimit: userOp.paymasterVerificationGasLimit,
    paymasterPostOpGasLimit: userOp.paymasterPostOpGasLimit,
  };
}

async function payWithUserOp(url, terms, operation, signature) {
  const payload = {
    x402Version: 2,
    accepted: terms,
    payload: {
      signature,
      authorization: {
        from: operation.from,
        sessionKeysProvider: operation.policy,
        permissionId: operation.permissionId,
        sessionKeys: [operation.sessionKeyAddress],
        nonce: operation.nonce,
        entryPoint: operation.entryPoint,
        maxFeePerGas: operation.maxFeePerGas,
        maxPriorityFeePerGas: operation.maxPriorityFeePerGas,
      },
    },
  };

  const encoded = encodeHeader(payload);
  const response = await fetch(url, {
    headers: { accept: '*/*', 'payment-signature': encoded, 'x-payment': encoded },
  });
  const receiptHeader = response.headers.get('x-payment-response');
  return {
    status: response.status,
    body: await response.text(),
    receipt: receiptHeader ? decodeHeader(receiptHeader) : null,
  };
}

// ── Sessions file ─────────────────────────────────────────────────────────────

function loadSessions(filePath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error(`Error: cannot read sessions file "${filePath}": ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    console.error('Error: sessions file must be a non-empty JSON array');
    process.exit(1);
  }
  const required = ['sessionGrantId', 'permissionId', 'walletAddress', 'sessionKeyAddress', 'sessionPrivateKey'];
  for (let i = 0; i < raw.length; i++) {
    const missing = required.filter((k) => !raw[i][k]);
    if (missing.length) {
      console.error(`Error: session[${i}] missing fields: ${missing.join(', ')}`);
      process.exit(1);
    }
  }
  return raw;
}

// ── Per-payment benchmark ─────────────────────────────────────────────────────

const EP_ABI = parseAbi(['function getNonce(address,uint192) view returns (uint256)']);

// ── Concurrency limits ────────────────────────────────────────────────────────
//
// SIGN_RPC_CONCURRENCY (default 0 = off): > 0 splits every payment into "prepare" (quote + nonce/fees read + sign) and
//   "submit" (POST the signed payment), runs prepare with at most this many in flight, then submits. prep is NOT in wall.
// SUBMIT_CONCURRENCY (default 100, only with the above): payments in flight at once while submitting, as a sliding
//   window (a new one starts the moment one finishes). 100 is the burst this public RPC has already verified and settled;
//   a larger burst dies inside /verify and the facilitator reports it as `malformed`.

function envInt(name, fallback, min) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    console.error(`${name} must be an integer >= ${min}`);
    process.exit(1);
  }
  return n;
}
const signRpcConcurrency = () => envInt('SIGN_RPC_CONCURRENCY', 0, 0);
const submitConcurrency = () => envInt('SUBMIT_CONCURRENCY', 100, 1);

async function mapPool(limit, items, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

// ── Per-payment steps ─────────────────────────────────────────────────────────

const failure = (index, startedAt, got402At, signedAt, status, error) => {
  const completedAt = Date.now();
  return { index, startedAt, got402At, signedAt, completedAt, durationMs: completedAt - startedAt, status, txHash: null, error };
};

/** Quote, read nonce + fees, sign. Returns { ready } to submit, or { done } when it already failed. */
async function prepareOne(config, chain, fees, session, merchantUrl, index) {
  const startedAt = Date.now();
  let got402At = null;
  try {
    // Phase 1: GET merchant → 402
    const quoted = await quote(merchantUrl);
    got402At = Date.now();
    if (!quoted.terms) {
      return { done: failure(index, startedAt, got402At, null, quoted.status, `Expected 402 but got HTTP ${quoted.status}`) };
    }
    const { terms } = quoted;
    const aa = aaTermsFrom(terms);

    // Phase 2: nonce (+ fees unless the caller already has them), then sign
    const account = session.walletAddress;
    const permissionId = session.permissionId;
    const key = encodeNonce({
      mode: 0x00, validationType: VALIDATION_TYPE_PERMISSION,
      identifier: permissionId, lane: 0, sequence: 0n,
    }) >> 64n;

    const [nonce, feesNow] = await Promise.all([
      chain.readContract({ address: aa.entryPoint, abi: EP_ABI, functionName: 'getNonce', args: [account, key] }),
      fees ?? honestFees(chain),
    ]);

    const paymasterAndData = `0x${aa.paymaster.slice(2)}${hex16(aa.paymasterVerificationGasLimit)}${hex16(aa.paymasterPostOpGasLimit)}`;
    const callData = canonicalTransferCallData(config.usd8Address, String(terms.payTo), BigInt(terms.amount));
    const op = {
      sender: account,
      nonce,
      initCode: '0x',
      callData,
      accountGasLimits: packAccountGasLimits(BigInt(aa.verificationGasLimit), BigInt(aa.callGasLimit)),
      preVerificationGas: BigInt(aa.preVerificationGas),
      gasFees: packGasFees(feesNow.maxPriorityFeePerGas, feesNow.maxFeePerGas),
      paymasterAndData,
      signature: '0x',
    };

    const hash = userOpHash(op, aa.entryPoint, config.chainId);
    const sessionKey = privateKeyToAccount(session.sessionPrivateKey);
    const rawSig = await sessionKey.signMessage({ message: { raw: hash } });
    const signature = encodePermissionSignature(rawSig);
    const signedAt = Date.now();

    return {
      ready: {
        index, startedAt, got402At, signedAt, terms, signature, userOpHash: hash,
        auth: {
          from: account,
          policy: aa.policy,
          permissionId,
          sessionKeyAddress: session.sessionKeyAddress,
          nonce: nonce.toString(),
          entryPoint: aa.entryPoint,
          maxFeePerGas: feesNow.maxFeePerGas.toString(),
          maxPriorityFeePerGas: feesNow.maxPriorityFeePerGas.toString(),
        },
      },
    };
  } catch (e) {
    return { done: failure(index, startedAt, got402At, null, null, e.message) };
  }
}

/**
 * Tells the RPC counting proxy (compare-ledger.sh, COUNT_RPC=1) which payment each nonce key and userOpHash belongs
 * to, so that its call log can tag every JSON-RPC call with the payment it served. The `index` is the `[n]` of this
 * script's own output. A no-op without RPC_COUNTER_URL, and never fatal: a failure only leaves calls untagged.
 */
async function registerPayments(readies) {
  const base = process.env.RPC_COUNTER_URL;
  if (!base || readies.length === 0) return;
  try {
    const body = readies.map((r) => ({
      index: r.index,
      // The nonce read from the EntryPoint is `key << 64 | sequence`.
      key: (BigInt(r.auth.nonce) >> 64n).toString(16).padStart(48, '0'),
      userOpHash: r.userOpHash,
      permissionId: r.auth.permissionId,
    }));
    const res = await fetch(`${base}/__payments`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.warn(`could not register payments with the RPC call log (${e.message}); its calls stay untagged`);
  }
}

/** Phase 3: submit the signed payment and wait for the merchant's answer. */
async function submitOne(ready, merchantUrl, timed) {
  const startedAt = timed ? Date.now() : ready.startedAt;
  try {
    const resource = await payWithUserOp(merchantUrl, ready.terms, ready.auth, ready.signature);
    const completedAt = Date.now();
    return {
      index: ready.index, startedAt,
      // In the capped path the quote and the signing happened earlier, so their offsets from `startedAt` mean nothing.
      got402At: timed ? null : ready.got402At, signedAt: timed ? null : ready.signedAt,
      completedAt, durationMs: completedAt - startedAt,
      status: resource.status,
      txHash: resource.receipt?.transaction ?? null,
      error: resource.status === 200 ? null : `HTTP ${resource.status}: ${resource.body.slice(0, 200)}`,
    };
  } catch (e) {
    return failure(ready.index, startedAt, timed ? null : ready.got402At, timed ? null : ready.signedAt, null, e.message);
  }
}

/** Everything at once, no limits: the original behaviour (SIGN_RPC_CONCURRENCY unset or 0). */
async function payOne(config, session, merchantUrl, index) {
  const chain = createPublicClient({ transport: http(config.rpcUrl) });
  const prepared = await prepareOne(config, chain, null, session, merchantUrl, index);
  if (prepared.done) return prepared.done;
  await registerPayments([prepared.ready]);
  return submitOne(prepared.ready, merchantUrl, false);
}

// ── Output ────────────────────────────────────────────────────────────────────

function printTimingLine(t) {
  const s402 = t.got402At != null ? `${t.got402At - t.startedAt}ms` : 'n/a';
  const sSigned = t.signedAt != null ? `${t.signedAt - t.startedAt}ms` : 'n/a';
  const start = new Date(t.startedAt).toISOString();
  if (t.txHash) {
    console.log(`[${String(t.index).padStart(3)}] OK   start=${start} 402=+${s402} signed=+${sSigned} done=+${t.durationMs}ms txHash=${t.txHash}`);
  } else {
    console.log(`[${String(t.index).padStart(3)}] FAIL start=${start} 402=+${s402} signed=+${sSigned} done=+${t.durationMs}ms error=${t.error}`);
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function printSummary(timings, wallMs) {
  const successes = timings.filter((t) => t.status === 200);
  const failures = timings.filter((t) => t.status !== 200);
  const durations = timings.map((t) => t.durationMs).sort((a, b) => a - b);

  console.log('\n─── Summary ───────────────────────────────────────────');
  console.log(`total:    ${timings.length}`);
  console.log(`success:  ${successes.length}`);
  console.log(`failure:  ${failures.length}`);

  if (durations.length > 0) {
    const avg = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
    console.log(`min:      ${durations[0]}ms`);
    console.log(`max:      ${durations[durations.length - 1]}ms`);
    console.log(`avg:      ${avg}ms`);
    console.log(`p50:      ${percentile(durations, 50)}ms`);
    console.log(`p95:      ${percentile(durations, 95)}ms`);
    console.log(`p99:      ${percentile(durations, 99)}ms`);
  }

  console.log(`wall:     ${wallMs}ms`);
  console.log('──────────────────────────────────────────────────────');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const sessionsFile = process.argv[2];
  const merchantUrl = process.argv[3];

  if (!sessionsFile || !merchantUrl) {
    console.error('usage: node bench-pay.js <sessions-file> <merchant-url>');
    console.error('  sessions-file  path to JSON file from setup-bench-sessions.js');
    console.error('  merchant-url   URL to benchmark, e.g. http://localhost:3004/pay');
    process.exit(1);
  }

  const sessions = loadSessions(sessionsFile);
  const config = loadConfig();

  console.log(`bench-pay: ${sessions.length} session(s) → ${merchantUrl}`);
  console.log(`chainId=${config.chainId}  rpc=${config.rpcUrl}`);
  const prepLimit = signRpcConcurrency();
  let timings;
  let wallStart;
  let wallEnd;
  if (prepLimit > 0) {
    // Sign with a few chain reads in flight, then submit as a sliding window: wall is the time to finish every submit.
    const inFlight = submitConcurrency();
    const chain = createPublicClient({ transport: http(config.rpcUrl, { timeout: 20_000, retryCount: 2 }) });
    const fees = await honestFees(chain);
    console.log(`signing with at most ${prepLimit} nonce reads in flight...`);
    const prepStart = Date.now();
    const prepared = await mapPool(prepLimit, sessions, (s, i) => prepareOne(config, chain, fees, s, merchantUrl, i + 1));
    console.log(`prep:     ${Date.now() - prepStart}ms (not included in wall)`);
    await registerPayments(prepared.filter((p) => p.ready).map((p) => p.ready));
    console.log(`submitting with at most ${inFlight} payments in flight...\n`);
    wallStart = Date.now();
    timings = await mapPool(inFlight, prepared, (p) => (p.done ? p.done : submitOne(p.ready, merchantUrl, true)));
    wallEnd = Date.now();
  } else {
    console.log('firing all payments concurrently...\n');
    wallStart = Date.now();
    const settled = await Promise.allSettled(sessions.map((s, i) => payOne(config, s, merchantUrl, i + 1)));
    wallEnd = Date.now();
    timings = settled.map((r, i) =>
      r.status === 'fulfilled' ? r.value : {
        index: i + 1, startedAt: wallStart, got402At: null, signedAt: null,
        completedAt: wallEnd, durationMs: wallEnd - wallStart,
        status: null, txHash: null, error: String(r.reason?.message ?? r.reason),
      }
    );
  }

  console.log();
  for (const t of timings) printTimingLine(t);
  printSummary(timings, wallEnd - wallStart);
}

main().catch((e) => { console.error('fatal:', e.message); process.exit(1); });
