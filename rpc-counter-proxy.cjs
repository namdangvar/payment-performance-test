#!/usr/bin/env node
// Counts the JSON-RPC calls that pass through it, per method, and forwards them unchanged. It can also write one log
// line per call, tagged with the payment the call belongs to, so a slow run can be split into "the facilitator was
// slow" and "the RPC was slow".
//
//   node rpc-counter-proxy.cjs --upstream https://rpc-test.qday.info [--port 3099] [--log calls.jsonl]
//
// Point the facilitator's RPC_URLS at http://localhost:<port>. compare-ledger.sh does this for you.
//
//   GET  /__stats      -> { total, httpRequests, byMethod, tagged, payments, maxInflight, since, until }
//   POST /__reset      -> zeroes the counters (and writes a {"event":"reset"} marker to the log)
//   POST /__payments   -> registers payments: [{ index, key, userOpHash, permissionId? }]  (see below)
//   GET  /__payments   -> { count, payments: [{ index, userOpHash }] }
//
// A JSON-RPC batch counts as one call per entry (what the node actually has to answer), and as one httpRequest.
// Anything that is not a JSON-RPC body is forwarded and counted under "(unparsed)".
//
// ── The call log (--log) ─────────────────────────────────────────────────────────────────────────────────────────
// One JSON object per line, written when the call finishes:
//   recvMs / recvAt   when the proxy RECEIVED the request (epoch ms / ISO) — the moment "the RPC got it"
//   upstreamMs        from forwarding it to the answer being complete: how long the RPC took, queueing included
//   doneMs            recvMs + the time to the end of the answer (what the facilitator waited for)
//   inflight          upstream HTTP requests in flight at that moment, this one included: how loaded the RPC was
//   method, http, batch   the JSON-RPC method, the id of the HTTP request, and how many calls it carried
//   status, rpcError  HTTP status of the answer, and whether this call's answer was a JSON-RPC error
//   payment, via     the payment the call belongs to (the `[n]` of bench-pay's output) and how it was recognised
//   userOpHash, tx    the payment's userOpHash (every tagged call) and its transaction hash (calls from its broadcast on;
//                     a call that finished before the broadcast was seen has none). To be sure a number really is that
//                     payment, compare `tx` with the txHash bench-pay prints for the same `[n]`: rpc-timeline.cjs does it.
//   {"event":"payment"}  written once per payment at its broadcast: { payment, tx, userOpHash }
//
// ⭐ How a call is tied to a payment: the RPC never sees a payment id, but the call data carries values that are unique
// per payment. bench-pay registers them (POST /__payments) before it submits:
//   key         the 192-bit nonce key (one per session; the smart account itself is shared by every session)
//   userOpHash  the hash that is signed
// Words of the call data that equal one of them tag the call (via = "key" | "userOpHash"). eth_sendRawTransaction is
// decoded, its transaction hash remembered, and later eth_getTransactionReceipt / eth_getTransactionByHash calls for
// that hash are tagged too (via = "txHash"). Calls that belong to no single payment (eth_blockNumber, polling,
// balance of the shared account) have payment = null.
'use strict';
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const upstream = arg('upstream', process.env.UPSTREAM_RPC_URL);
const port = Number(arg('port', process.env.RPC_PORT || '3099'));
const logPath = arg('log', process.env.RPC_CALL_LOG_FILE);
if (!upstream) {
  console.error('usage: node rpc-counter-proxy.cjs --upstream <rpc url> [--port 3099] [--log calls.jsonl]');
  process.exit(1);
}
const target = new URL(upstream);
const client = target.protocol === 'https:' ? https : http;

// viem is only needed to decode a raw transaction and hash it; without it calls are still counted and logged.
let viem = null;
try { viem = require('viem'); } catch { /* optional */ }

const logStream = logPath ? fs.createWriteStream(path.resolve(logPath), { flags: 'a' }) : null;
const writeLog = (entry) => { if (logStream) logStream.write(`${JSON.stringify(entry)}\n`); };

let byMethod = {};
let total = 0;
let httpRequests = 0;
let tagged = 0;
let maxInflight = 0;
let inflight = 0;
let nextHttpId = 0;
let since = new Date().toISOString();

// Payment registry. Needles are lowercase hex without 0x.
const byKey = new Map(); // 48 hex chars (192 bits) -> payment index
const byUserOpHash = new Map(); // 64 hex chars -> payment index
const byTxHash = new Map(); // 0x… transaction hash -> payment index
const userOpHashOf = new Map(); // payment index -> 0x… userOpHash (known before anything is sent)
const txOf = new Map(); // payment index -> 0x… transaction hash (known once its broadcast has been seen)

function reset() {
  byMethod = {};
  total = 0;
  httpRequests = 0;
  tagged = 0;
  maxInflight = 0;
  since = new Date().toISOString();
  writeLog({ event: 'reset', at: since, atMs: Date.now() });
}

function registerPayments(list) {
  let added = 0;
  for (const p of Array.isArray(list) ? list : []) {
    if (!Number.isInteger(p.index)) continue;
    if (typeof p.key === 'string') { byKey.set(p.key.replace(/^0x/, '').toLowerCase().padStart(48, '0'), p.index); added += 1; }
    if (typeof p.userOpHash === 'string') { byUserOpHash.set(p.userOpHash.replace(/^0x/, '').toLowerCase(), p.index); userOpHashOf.set(p.index, p.userOpHash.toLowerCase()); added += 1; }
  }
  return added;
}

/** 32-byte words of call data (selector skipped) that match a registered payment. */
function paymentFromData(dataHex) {
  const data = dataHex.replace(/^0x/, '').toLowerCase();
  for (let i = 8; i + 64 <= data.length; i += 64) {
    const w = data.slice(i, i + 64);
    if (byUserOpHash.has(w)) return { payment: byUserOpHash.get(w), via: 'userOpHash' };
    // getNonce(sender, key): the key is a uint192, left-padded to a word.
    if (w.startsWith('0000000000000000') && byKey.has(w.slice(16))) return { payment: byKey.get(w.slice(16)), via: 'key' };
    // a UserOperation's nonce is key << 64 | sequence: the key is its first 192 bits.
    if (byKey.has(w.slice(0, 48))) return { payment: byKey.get(w.slice(0, 48)), via: 'key' };
  }
  return null;
}

/** Which payment (if any) a call belongs to, plus the transaction hash when the call is a broadcast. */
function tag(call) {
  const params = call && Array.isArray(call.params) ? call.params : [];
  const first = params[0];
  if (call.method === 'eth_sendRawTransaction' && typeof first === 'string') {
    let found = null;
    let hash = null;
    if (viem) {
      try {
        hash = viem.keccak256(first);
        const tx = viem.parseTransaction(first);
        if (tx.data) found = paymentFromData(tx.data);
      } catch { /* not a transaction we can decode: fall through to the substring scan */ }
    }
    if (!found) {
      const raw = first.toLowerCase();
      for (const [needle, index] of byKey) if (raw.includes(needle)) { found = { payment: index, via: 'key' }; break; }
    }
    if (found && hash) {
      byTxHash.set(hash.toLowerCase(), found.payment);
      txOf.set(found.payment, hash.toLowerCase());
      // One self-contained line that ties the three identifiers of a payment together.
      writeLog({ event: 'payment', payment: found.payment, tx: hash.toLowerCase(), userOpHash: userOpHashOf.get(found.payment) ?? null, atMs: Date.now() });
    }
    return found ? { ...found, tx: hash } : { payment: null, via: null, tx: hash };
  }
  if ((call.method === 'eth_getTransactionReceipt' || call.method === 'eth_getTransactionByHash') && typeof first === 'string') {
    const index = byTxHash.get(first.toLowerCase());
    return index === undefined ? { payment: null, via: null, tx: first } : { payment: index, via: 'txHash', tx: first };
  }
  if (first && typeof first === 'object') {
    const data = first.data ?? first.input;
    if (typeof data === 'string') {
      const found = paymentFromData(data);
      if (found) return found;
    }
  }
  return { payment: null, via: null };
}

function parseCalls(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { calls: [{ method: '(unparsed)' }], batch: 1 };
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return { calls: list.map((c) => (c && typeof c === 'object' ? c : { method: '(unknown)' })), batch: list.length };
}

/** id -> true when that call's answer was a JSON-RPC error. */
function rpcErrors(answer) {
  const out = new Map();
  try {
    const parsed = JSON.parse(answer);
    for (const r of Array.isArray(parsed) ? parsed : [parsed]) if (r && r.id !== undefined) out.set(r.id, Boolean(r.error));
  } catch { /* an answer that is not JSON: no per-call verdict */ }
  return out;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/__stats') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      total, httpRequests, byMethod, tagged, payments: byKey.size, maxInflight, since, until: new Date().toISOString(),
    }));
    return;
  }
  if (req.method === 'POST' && req.url === '/__reset') {
    reset();
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
    return;
  }
  if (req.url === '/__payments') {
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        count: byKey.size,
        payments: [...userOpHashOf].map(([index, userOpHash]) => ({ index, userOpHash })), // read by db-event-watcher.cjs
      }));
      return;
    }
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let added = 0;
        try { added = registerPayments(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { /* bad body */ }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, added, count: byKey.size }));
      });
      return;
    }
  }

  const recvMs = Date.now();
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const isRpc = req.method === 'POST';
    const parsed = isRpc ? parseCalls(body.toString('utf8')) : null;
    const http_ = ++nextHttpId;
    if (isRpc) {
      httpRequests += 1;
      for (const call of parsed.calls) {
        const m = typeof call.method === 'string' ? call.method : '(unknown)';
        byMethod[m] = (byMethod[m] ?? 0) + 1;
        total += 1;
      }
    }
    // Tagged on arrival: a broadcast registers its transaction hash before the receipt calls for it come in.
    const tags = isRpc ? parsed.calls.map(tag) : [];
    tagged += tags.filter((t) => t.payment !== null).length;
    inflight += 1;
    if (inflight > maxInflight) maxInflight = inflight;
    const inflightAtRecv = inflight;
    const forwardedMs = Date.now();
    let finished = false;
    const answerChunks = [];

    const finish = (status, aborted) => {
      if (finished) return;
      finished = true;
      inflight -= 1;
      if (!isRpc || !logStream) return;
      const doneMs = Date.now();
      const errors = aborted ? new Map() : rpcErrors(Buffer.concat(answerChunks).toString('utf8'));
      parsed.calls.forEach((call, i) => {
        const entry = {
          recvMs, recvAt: new Date(recvMs).toISOString(), upstreamMs: doneMs - forwardedMs, doneMs,
          inflight: inflightAtRecv, method: typeof call.method === 'string' ? call.method : '(unknown)',
          http: http_, batch: parsed.batch, status, payment: tags[i].payment, via: tags[i].via,
        };
        if (tags[i].payment !== null) {
          entry.userOpHash = userOpHashOf.get(tags[i].payment) ?? null;
          const tx = tags[i].tx ?? txOf.get(tags[i].payment);
          if (tx) entry.tx = tx; // calls that finished before this payment's broadcast was seen have none yet
        } else if (tags[i].tx) {
          entry.tx = tags[i].tx;
        }
        if (call.id !== undefined && errors.has(call.id)) entry.rpcError = errors.get(call.id);
        if (aborted) entry.aborted = true;
        writeLog(entry);
      });
    };

    const headers = { ...req.headers, host: target.host, 'content-length': body.length };
    const out = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: (target.pathname === '/' ? '' : target.pathname) + (req.url === '/' ? '' : req.url),
        method: req.method,
        headers,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.on('data', (c) => { if (logStream) answerChunks.push(c); });
        up.on('end', () => finish(up.statusCode ?? 502, false));
        up.on('close', () => { if (!up.complete) finish(up.statusCode ?? 502, true); });
        up.pipe(res);
      },
    );
    out.on('error', (e) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `upstream: ${e.message}` }));
      finish(502, true);
    });
    // The facilitator gave up (its own timeout) before the RPC answered: still worth a line, flagged.
    res.on('close', () => finish(res.statusCode || 0, true));
    out.end(body);
  });
});

server.listen(port, () => console.log(`rpc-counter-proxy on :${port} -> ${upstream}${logPath ? `  (call log: ${logPath})` : ''}`));

function shutdown() {
  const done = () => process.exit(0);
  if (logStream) logStream.end(done); else done();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
