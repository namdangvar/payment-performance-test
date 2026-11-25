#!/usr/bin/env node
// Draws the timeline of the payments of one run and says where the time went.
//
//   node rpc-timeline.cjs <results-dir> <config>-<run> [--show 3] [--width 64] [--chain]
//   node rpc-timeline.cjs compare-results/20261105-102554 D-1
//   node rpc-timeline.cjs compare-results/20261105-102554 D-1 --show 5 --chain
//
// Reads, from the results dir of compare-ledger.sh:
//   <config>-<run>.txt               bench-pay's output: when each payment started and finished (ms precision)
//   rpc-calls-<config>-<run>.jsonl   the RPC call log: when the RPC received each call and how long it took
//
// Shows the first `--show` and the last `--show` payments and skips the ones between, then a table of the phases over ALL
// payments, so the slowest phase is visible even when its payments are not drawn.
//
// ⚠️ Only calls the proxy could tie to a payment count. A payment's "first RPC call" is the first TAGGED one, so the
// phase before it can include a few untagged calls that were already on their way (see README, "The call log").
//
// --chain also asks the RPC when each payment's transaction was mined (block timestamp, 1 s resolution) and splits the wait
// in two. It makes extra read calls; it first calibrates this machine's clock on a new block and skips the split when the
// clocks differ by more than 5 s.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && all[i - 1].startsWith('--') && !['--chain'].includes(all[i - 1])));
const [dir, cfgRun] = positional;
if (!dir || !cfgRun) {
  console.error('usage: node rpc-timeline.cjs <results-dir> <config>-<run> [--show 3] [--width 64] [--chain]');
  process.exit(1);
}
const SHOW = Math.max(1, Number(flag('show', 3)));
const WIDTH = Math.max(30, Number(flag('width', 64)));
const WITH_CHAIN = flag('chain', false) !== false;

// ── read the two files ───────────────────────────────────────────────────────────────────────────────────────────
const benchFile = path.join(dir, `${cfgRun}.txt`);
const logFile = path.join(dir, `rpc-calls-${cfgRun}.jsonl`);
for (const f of [benchFile, logFile]) if (!fs.existsSync(f)) { console.error(`missing ${f}`); process.exit(1); }

const payments = new Map();
for (const line of fs.readFileSync(benchFile, 'utf8').split('\n')) {
  const m = line.match(/^\[\s*(\d+)\] (OK|FAIL)\s+start=(\S+).*?done=\+(\d+)ms\s+(?:txHash=(0x[0-9a-fA-F]+))?/);
  if (!m) continue;
  const start = Date.parse(m[3]);
  payments.set(Number(m[1]), { index: Number(m[1]), ok: m[2] === 'OK', start, done: start + Number(m[4]), tx: m[5] ?? null, calls: [] });
}
if (payments.size === 0) { console.error(`no payment lines in ${benchFile}`); process.exit(1); }

let afterReset = false;
const allCalls = [];
const broadcasts = new Map(); // payment -> tx hash, from the {"event":"payment"} lines
for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const e = JSON.parse(line);
  if (e.event === 'reset') { afterReset = true; continue; }
  if (e.event === 'payment') { if (afterReset) broadcasts.set(e.payment, e.tx); continue; }
  if (e.event || !afterReset) continue; // other events, and boot-time calls
  allCalls.push(e);
  if (e.payment !== null && payments.has(e.payment)) payments.get(e.payment).calls.push(e);
}

// when each payment's event first showed up in the DB table (db-event-watcher.cjs), if it ran
const seenFile = path.join(dir, `index-seen-${cfgRun}.jsonl`);
let dbSeen = 0;
if (fs.existsSync(seenFile)) {
  for (const line of fs.readFileSync(seenFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if (payments.has(e.payment)) { payments.get(e.payment).minedMs = e.seenMs; dbSeen += 1; }
  }
}

// ── per payment phases ──────────────────────────────────────────────────────────────────────────────────────────
const list = [...payments.values()].sort((a, b) => a.index - b.index);
const t0 = Math.min(...list.map((p) => p.start));
for (const p of list) {
  const send = p.calls.find((c) => c.method === 'eth_sendRawTransaction');
  const first = p.calls.length ? Math.min(...p.calls.map((c) => c.recvMs)) : null;
  p.firstRpc = first;
  p.sendRecv = send ? send.recvMs : null;
  p.sendDone = send ? send.doneMs : null;
  p.sendMs = send ? send.upstreamMs : null;
}

// ── optional: when was each transaction mined ───────────────────────────────────────────────────────────────────
function rpcCall(upstream, method, params) {
  return new Promise((resolve, reject) => {
    const u = new URL(upstream);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = (u.protocol === 'https:' ? https : http).request(
      { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b).result); } catch (e) { reject(e); } }); },
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.end(body);
  });
}
async function addMinedTimes() {
  let upstream = process.env.UPSTREAM_RPC_URL;
  if (!upstream) {
    const envFile = path.resolve(__dirname, '../qday-payment-facilitator/.env');
    if (fs.existsSync(envFile)) upstream = (fs.readFileSync(envFile, 'utf8').match(/^RPC_URLS=(.*)$/m) || [])[1]?.split(',')[0].replace(/["\s]/g, '');
  }
  if (!upstream) { console.error('--chain: set UPSTREAM_RPC_URL'); return null; }
  // Calibrate: block timestamps are the chain's clock, in whole seconds. Watch for a NEW block to appear and compare the
  // moment we saw it with its timestamp: that offset (clock difference + the delay until the RPC serves it) is then
  // added to every block timestamp, so the marker lands where the block became visible to us.
  let skewMs = null;
  let prev = await rpcCall(upstream, 'eth_getBlockByNumber', ['latest', false]);
  for (let i = 0; i < 40 && skewMs === null; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const cur = await rpcCall(upstream, 'eth_getBlockByNumber', ['latest', false]);
    if (cur.number !== prev.number) skewMs = Date.now() - Number(BigInt(cur.timestamp)) * 1000;
    prev = cur;
  }
  if (skewMs === null) { console.error('--chain: no new block within 6 s, cannot calibrate'); return null; }
  const blocks = new Map();
  for (const p of list.filter((x) => x.tx)) {
    const r = await rpcCall(upstream, 'eth_getTransactionReceipt', [p.tx]);
    if (!r) continue;
    p.block = Number(BigInt(r.blockNumber));
    if (!blocks.has(p.block)) blocks.set(p.block, Number(BigInt((await rpcCall(upstream, 'eth_getBlockByNumber', [r.blockNumber, false])).timestamp)) * 1000 + skewMs);
    p.minedMs = blocks.get(p.block);
  }
  return { skewMs, blocks: blocks.size };
}

// ── drawing ────────────────────────────────────────────────────────────────────────────────────────────────────
const fmt = (ms) => (ms === null || ms === undefined ? 'n/a' : ms >= 10000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
const pct = (arr, p) => { const a = arr.filter((v) => v !== null && v !== undefined).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)] : null; };

function row(p, scale, mined) {
  const cells = new Array(WIDTH).fill(' ');
  const at = (ms) => Math.min(WIDTH - 1, Math.max(0, Math.floor(((ms - t0) / scale) * (WIDTH - 1))));
  const paint = (from, to, ch) => { if (from === null || to === null) return; for (let i = at(from); i <= Math.max(at(from), at(to)); i++) cells[i] = ch; };
  if (!p.calls.length || p.sendRecv === null) { paint(p.start, p.done, 'x'); return cells.join(''); } // never reached the broadcast
  paint(p.start, p.firstRpc, 'a');
  paint(p.firstRpc, p.sendRecv, 'c');
  paint(p.sendRecv, p.sendDone, 'B');
  if (mined && p.minedMs && p.minedMs > p.sendDone && p.minedMs < p.done) {
    paint(p.sendDone, p.minedMs, 'w');
    paint(p.minedMs, p.done, 'i');
    cells[at(p.minedMs)] = '|';
  } else {
    paint(p.sendDone, p.done, 'w');
  }
  return cells.join('');
}

(async () => {
  let chainInfo = null;
  if (WITH_CHAIN) {
    try { chainInfo = await addMinedTimes(); } catch (e) { console.error(`--chain failed (${e.message}); drawing without block times`); }
  }
  const fromDb = dbSeen > 0;
  const mined = fromDb || (Boolean(chainInfo) && Math.abs(chainInfo.skewMs) < 5000);
  if (!fromDb && chainInfo && !mined) console.log(`⚠️ clock of this machine is ${(chainInfo.skewMs / 1000).toFixed(1)}s off the chain's: block times not drawn.\n`);
  if (fromDb) console.log(`event times: from the DB table itself (db-event-watcher.cjs, ${dbSeen}/${list.length} payments); good to about one watcher interval (100ms by default).\n`);
  else if (mined) console.log(`block times: this machine's clock is ${(chainInfo.skewMs / 1000).toFixed(2)}s ahead of the chain's block timestamps (calibrated on a new block); mined markers are good to about ±1s.\n`);

  const wall = Math.max(...list.map((p) => p.done)) - t0;
  const scale = wall || 1;
  const ruler = (() => { const r = new Array(WIDTH).fill(' '); const step = wall > 6000 ? 2000 : wall > 2500 ? 500 : 250; const labels = []; for (let ms = 0; ms <= wall; ms += step) labels.push(ms);
    let line = ''; for (const ms of labels) { const col = Math.floor((ms / scale) * (WIDTH - 1)); const lab = ms % 1000 === 0 ? `${ms / 1000}s` : `${ms / 1000}`; if (line.length <= col) line = line.padEnd(col, ' ') + lab; } return line; })();

  // Is payment [n] of the bench output really payment n of the call log? Both sides know the transaction hash.
  const withTx = list.filter((p) => p.tx);
  const compared = withTx.filter((p) => broadcasts.has(p.index) || p.calls.some((c) => c.tx));
  const mismatched = compared.filter((p) => {
    const logged = broadcasts.get(p.index) ?? p.calls.find((c) => c.tx)?.tx;
    return !logged || logged.toLowerCase() !== p.tx.toLowerCase();
  });
  const idLine = compared.length === 0
    ? 'id check: no transaction hash in the call log to compare (log made before the txHash field existed?)'
    : mismatched.length === 0
      ? `id check: ${compared.length}/${withTx.length} payments: the txHash printed by bench-pay equals the txHash of the broadcast the call log tagged with the same number`
      : `⚠️ id check FAILED for payments ${mismatched.map((p) => p.index).join(', ')}: the number in the call log is not the same payment as in the bench output. Do not trust this timeline.`;

  console.log(`${cfgRun}  ·  ${list.length} payments  ·  ${list.filter((p) => p.ok).length} ok  ·  wall ${fmt(wall)}  ·  t=0 is the first payment sent\n`);
  console.log(`${idLine}\n`);
  console.log(`legend:  a = sent, RPC not yet reached   c = checks (reads before the broadcast)   B = broadcast (write RPC)`);
  console.log(`         w = after the broadcast until done${mined ? (fromDb ? ' (waiting for the block and rindexer)' : '') : ' (block + indexer + poll)'}${mined ? (fromDb ? '   | = event visible in the DB   i = from the event until done' : '   | = tx mined (block timestamp, ±1s)   i = after mined until done') : ''}   x = failed before broadcast\n`);
  console.log(`   #  ${ruler}`);
  const shown = list.length <= SHOW * 2 + 1 ? list : [...list.slice(0, SHOW), null, ...list.slice(-SHOW)];
  for (const p of shown) {
    if (p === null) { console.log(`  ... (${list.length - SHOW * 2} payments skipped) ...`); continue; }
    console.log(`${String(p.index).padStart(4)}  ${row(p, scale, mined)}  ${fmt(p.done - p.start)}${p.ok ? '' : ' FAIL'}`);
  }

  // phases over ALL payments
  const ph = {
    'sent -> first RPC call seen':       list.map((p) => (p.firstRpc === null ? null : p.firstRpc - p.start)),
    'checks (first RPC -> broadcast received)': list.map((p) => (p.sendRecv === null || p.firstRpc === null ? null : p.sendRecv - p.firstRpc)),
    'broadcast: RPC answer time (write)': list.map((p) => p.sendMs),
    'after broadcast -> done (block + indexer + poll)': list.map((p) => (p.sendDone === null ? null : p.done - p.sendDone)),
  };
  if (mined) {
    ph[fromDb ? '  of which: broadcast -> event visible in the DB' : '  of which: broadcast -> tx mined (±1s)'] = list.map((p) => (p.minedMs && p.sendDone ? Math.max(0, p.minedMs - p.sendDone) : null));
    ph[fromDb ? '  of which: event visible -> done (facilitator poll + answers)' : '  of which: tx mined -> done (indexer + poll)'] = list.map((p) => (p.minedMs && p.minedMs < p.done ? p.done - p.minedMs : null));
  }
  ph['whole payment'] = list.map((p) => p.done - p.start);

  console.log(`\nWhere the time goes, over ALL ${list.length} payments:`);
  console.log(`${'phase'.padEnd(52)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} ${'max'.padStart(8)}`);
  for (const [name, vals] of Object.entries(ph)) console.log(`${name.padEnd(52)} ${fmt(pct(vals, 50)).padStart(8)} ${fmt(pct(vals, 95)).padStart(8)} ${fmt(pct(vals, 100)).padStart(8)}`);

  const slow = [...list].sort((a, b) => (b.done - b.start) - (a.done - a.start))[0];
  console.log(`\nSlowest payment: #${slow.index} (${fmt(slow.done - slow.start)}): ` +
    `before RPC ${fmt(slow.firstRpc === null ? null : slow.firstRpc - slow.start)}, checks ${fmt(slow.sendRecv === null || slow.firstRpc === null ? null : slow.sendRecv - slow.firstRpc)}, ` +
    `broadcast ${fmt(slow.sendMs)}, wait after broadcast ${fmt(slow.sendDone === null ? null : slow.done - slow.sendDone)}`);

  // is the RPC itself the slow part?
  const reads = allCalls.filter((c) => c.method !== 'eth_sendRawTransaction').map((c) => c.upstreamMs);
  const writes = allCalls.filter((c) => c.method === 'eth_sendRawTransaction').map((c) => c.upstreamMs);
  const peak = allCalls.reduce((m, c) => (c.inflight > m.inflight ? c : m), { inflight: 0 });
  console.log(`\nThe RPC itself:  reads p50 ${fmt(pct(reads, 50))} p95 ${fmt(pct(reads, 95))} max ${fmt(pct(reads, 100))}  (${reads.length} calls)`);
  console.log(`                 writes (eth_sendRawTransaction) p50 ${fmt(pct(writes, 50))} max ${fmt(pct(writes, 100))}  (${writes.length} calls)`);
  console.log(`                 most requests in flight at once: ${peak.inflight}${peak.recvMs ? ` (at +${fmt(peak.recvMs - t0)})` : ''}`);

  // verdict: the phase that takes the largest share of the slowest payment
  const parts = [
    ['sent -> first RPC call seen (facilitator side, before it asks the RPC)', slow.firstRpc === null ? 0 : slow.firstRpc - slow.start],
    ['the checks before the broadcast (RPC reads)', slow.sendRecv === null || slow.firstRpc === null ? 0 : slow.sendRecv - slow.firstRpc],
    ['the broadcast itself (write RPC)', slow.sendMs ?? 0],
    ['waiting after the broadcast (block + indexer + poll)', slow.sendDone === null ? 0 : slow.done - slow.sendDone],
  ].sort((a, b) => b[1] - a[1]);
  const total = slow.done - slow.start;
  console.log(`\nLongest phase of the slowest payment: ${parts[0][0]}: ${fmt(parts[0][1])} (${Math.round((parts[0][1] / total) * 100)}% of ${fmt(total)}).`);
})();
