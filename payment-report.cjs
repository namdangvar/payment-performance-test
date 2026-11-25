#!/usr/bin/env node
// Builds the per-payment report of one run: one row per payment with its ids and every timestamp and duration needed to draw
// a timeline. compare-ledger.sh runs it after each run; to run it by hand:
//
//   node payment-report.cjs <results-dir> <config>-<run>        e.g.  node payment-report.cjs compare-results/20261105-102554 D-1
//
// Reads (from the results dir):
//   <config>-<run>.txt                  bench-pay's output: when each payment was sent and when the merchant's 200 came back
//   rpc-calls-<config>-<run>.jsonl      what the RPC received: every call, when, how long the RPC took, and which payment it served
//   index-seen-<config>-<run>.jsonl     (optional, db-event-watcher.cjs) when each payment's event first showed up in the DB table
// Writes:
//   report-<config>-<run>.csv           one row per payment (open it in a spreadsheet or feed a chart)
//   report-<config>-<run>.json          the same rows, plus the individual RPC requests of each payment, plus notes
//
// ── Columns (all times are ms; `…At` are ISO timestamps of this machine's clock, so they can be compared directly) ──────
//   payment            the `[n]` of bench-pay's output (the same n in the RPC call log)
//   userOpHash, txHash the payment's two on-chain identifiers; idCheck says whether bench-pay and the RPC log agree on the txHash
//   sentAt             bench-pay sent the payment to the merchant
//   sentToRpcMs        sent -> the RPC received the payment's first call that could be tied to it   (see note 1)
//   checksMs           that first call -> the RPC received the broadcast (the verify / settle reads before it)
//   broadcastRpcMs     the RPC's time to answer the broadcast (eth_sendRawTransaction): the write
//   broadcastAnsweredAt the RPC answered the broadcast: from here the facilitator waits for the chain
//   rpcCalls, rpcMsAvg, rpcMsMax   the RPC calls tied to this payment, and how long the RPC took per call (received -> answered)
//   eventInDbAt        the event first visible in the index table   (db-event-watcher; good to about one watcher interval)
//   broadcastToEventMs broadcast answered -> event visible: the block, then rindexer writing it
//   eventToDoneMs      event visible -> the merchant's 200 reached bench-pay: the facilitator's poll, its answer, the merchant, bench-pay
//   doneAt, totalMs    the merchant's 200 reached bench-pay; sent -> done
//
// Notes
//   1. Only calls tagged with the payment count (see README, "The call log"): sentToRpcMs can be a little late if an untagged
//      call of that payment was already on its way, and rpcCalls is about a third of everything the payment caused.
//   2. "Facilitator starts polling the DB" is not in these files: the facilitator logs no milliseconds. It starts right after
//      the broadcast was answered, so broadcastToEventMs is the time it has spent polling by the moment the event exists, and
//      eventToDoneMs is how long it then takes to notice and answer.
'use strict';
const fs = require('fs');
const path = require('path');

const [, , dir, cfgRun] = process.argv;
if (!dir || !cfgRun) { console.error('usage: node payment-report.cjs <results-dir> <config>-<run>'); process.exit(1); }
const benchFile = path.join(dir, `${cfgRun}.txt`);
const logFile = path.join(dir, `rpc-calls-${cfgRun}.jsonl`);
const seenFile = path.join(dir, `index-seen-${cfgRun}.jsonl`);
for (const f of [benchFile, logFile]) if (!fs.existsSync(f)) { console.error(`missing ${f}`); process.exit(1); }

const iso = (ms) => (ms === null || ms === undefined ? '' : new Date(ms).toISOString());
const diff = (a, b) => (a === null || a === undefined || b === null || b === undefined ? null : b - a);

// bench-pay output
const payments = new Map();
for (const line of fs.readFileSync(benchFile, 'utf8').split('\n')) {
  const m = line.match(/^\[\s*(\d+)\] (OK|FAIL)\s+start=(\S+).*?done=\+(\d+)ms\s+(?:txHash=(0x[0-9a-fA-F]+))?/);
  if (!m) continue;
  const sent = Date.parse(m[3]);
  payments.set(Number(m[1]), { payment: Number(m[1]), ok: m[2] === 'OK', sentMs: sent, doneMs: sent + Number(m[4]), benchTx: m[5] ? m[5].toLowerCase() : null, calls: [], userOpHash: null, logTx: null, seenMs: null, block: null });
}
if (payments.size === 0) { console.error(`no payment lines in ${benchFile}`); process.exit(1); }

// RPC call log (only what is after the reset marker: before it are boot-time calls)
let afterReset = false;
for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const e = JSON.parse(line);
  if (e.event === 'reset') { afterReset = true; continue; }
  if (!afterReset) continue;
  if (e.event === 'payment') {
    const p = payments.get(e.payment);
    if (p) { p.logTx = e.tx; p.userOpHash = p.userOpHash ?? e.userOpHash; }
    continue;
  }
  if (e.event || e.payment === null || !payments.has(e.payment)) continue;
  const p = payments.get(e.payment);
  p.calls.push(e);
  if (e.userOpHash) p.userOpHash = e.userOpHash;
  if (e.tx && !p.logTx) p.logTx = e.tx;
}

// when the event became visible in the DB
let watcherLines = 0;
if (fs.existsSync(seenFile)) {
  for (const line of fs.readFileSync(seenFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    watcherLines += 1;
    const p = payments.get(e.payment);
    if (p) { p.seenMs = e.seenMs; p.block = e.block; }
  }
}

const rows = [...payments.values()].sort((a, b) => a.payment - b.payment).map((p) => {
  const send = p.calls.find((c) => c.method === 'eth_sendRawTransaction');
  const firstRpc = p.calls.length ? Math.min(...p.calls.map((c) => c.recvMs)) : null;
  const ups = p.calls.map((c) => c.upstreamMs);
  const txHash = p.logTx ?? p.benchTx;
  return {
    payment: p.payment,
    ok: p.ok,
    userOpHash: p.userOpHash ?? '',
    txHash: txHash ?? '',
    idCheck: p.benchTx && p.logTx ? (p.benchTx === p.logTx ? 'match' : 'MISMATCH') : 'n/a',
    sentAt: iso(p.sentMs),
    sentToRpcMs: diff(p.sentMs, firstRpc),
    checksMs: diff(firstRpc, send ? send.recvMs : null),
    broadcastRpcMs: send ? send.upstreamMs : null,
    broadcastAnsweredAt: send ? iso(send.doneMs) : '',
    rpcCalls: p.calls.length,
    rpcMsAvg: ups.length ? Math.round(ups.reduce((a, b) => a + b, 0) / ups.length) : null,
    rpcMsMax: ups.length ? Math.max(...ups) : null,
    eventInDbAt: iso(p.seenMs),
    dbBlock: p.block,
    broadcastToEventMs: diff(send ? send.doneMs : null, p.seenMs),
    eventToDoneMs: diff(p.seenMs, p.doneMs),
    doneAt: iso(p.doneMs),
    totalMs: p.doneMs - p.sentMs,
    _requests: p.calls.map((c) => ({ method: c.method, receivedAt: c.recvAt, rpcMs: c.upstreamMs, inflight: c.inflight, via: c.via, rpcError: c.rpcError ?? false })),
  };
});

const cols = Object.keys(rows[0]).filter((k) => !k.startsWith('_'));
const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => (r[c] === null || r[c] === undefined ? '' : String(r[c]))).join(','))].join('\n') + '\n';
const csvPath = path.join(dir, `report-${cfgRun}.csv`);
const jsonPath = path.join(dir, `report-${cfgRun}.json`);
fs.writeFileSync(csvPath, csv);
const settingsFile = path.join(dir, `settings-${cfgRun}.json`);
fs.writeFileSync(jsonPath, JSON.stringify({
  run: cfgRun,
  settings: fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : null,
  generatedAt: new Date().toISOString(),
  sources: { bench: path.basename(benchFile), rpcCalls: path.basename(logFile), dbEvents: fs.existsSync(seenFile) ? path.basename(seenFile) : null },
  notes: [
    'sentToRpcMs counts only calls tied to the payment; rpcCalls is about a third of the calls a payment causes.',
    'The facilitator starts polling the DB right after the broadcast was answered; the DB is not visible to the benchmark, so eventInDbAt comes from db-event-watcher.cjs (good to about its interval).',
    'All timestamps are from this machine\'s clock.',
  ],
  payments: rows,
}, null, 2));

const bad = rows.filter((r) => r.idCheck === 'MISMATCH').map((r) => r.payment);
const withDb = rows.filter((r) => r.eventInDbAt).length;
console.log(`report: ${rows.length} payments -> ${csvPath}`);
console.log(`        ids: ${bad.length ? `⚠️ txHash MISMATCH for payments ${bad.join(', ')}` : `${rows.filter((r) => r.idCheck === 'match').length}/${rows.length} payments: bench txHash == RPC-log txHash`}` +
  `;  DB event time: ${fs.existsSync(seenFile) ? `${withDb}/${rows.length}` : 'not recorded (no index-seen file)'}`);
