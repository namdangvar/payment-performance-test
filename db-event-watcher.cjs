#!/usr/bin/env node
// Records WHEN each payment's UserOperationEvent first becomes visible in the chain-index table, to the millisecond-ish.
//
//   node db-event-watcher.cjs <facilitator-dir> --out events.jsonl [--proxy http://localhost:3099] [--interval 100] [--max-seconds 120]
//
// Why: the benchmark cannot see the database. The facilitator only learns about a mined payment by polling that table, so
// "the event is in the table at T" splits the wait after the broadcast in two:
//   broadcast answered -> event visible in the table   (the block, then rindexer writing it)
//   event visible      -> payment done                 (the facilitator's next poll, its answer, the merchant, the agent)
//
// How: asks the counting proxy which payments exist (GET /__payments: index + userOpHash, registered by bench-pay), then every
// `--interval` ms runs ONE read-only query for the hashes not seen yet, and writes a line when a hash first shows up:
//   { payment, userOpHash, seenMs, seenAt, afterPollStartMs, tx, block }
// `seenMs` is when our query RETURNED with the row, so the event appeared between the previous query's start and `seenMs`
// (`afterPollStartMs` is that previous start): the error is at most one interval plus a query's round trip.
//
// It reads with the facilitator's own role (DATABASE_URL and CHAIN_INDEX_USEROP_TABLE from <facilitator-dir>/.env) and only
// SELECTs. It is one more reader of the table (about 10 small indexed queries per second): leave it off with DB_EVENT_LOG=0
// when you want the facilitator alone on the database.
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');

const facDir = process.argv[2];
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
if (!facDir || facDir.startsWith('--')) {
  console.error('usage: node db-event-watcher.cjs <facilitator-dir> --out events.jsonl [--proxy http://localhost:3099] [--interval 100] [--max-seconds 120]');
  process.exit(1);
}
const out = arg('out');
const proxy = arg('proxy', 'http://localhost:3099');
const interval = Number(arg('interval', 100));
const maxMs = Number(arg('max-seconds', 120)) * 1000;
if (!out) { console.error('--out is required'); process.exit(1); }

function envValue(name) {
  if (process.env[name]) return process.env[name];
  const line = fs.readFileSync(path.join(facDir, '.env'), 'utf8').split('\n').find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim().replace(/^"|"$/g, '') : undefined;
}
const databaseUrl = envValue('DATABASE_URL');
const table = envValue('CHAIN_INDEX_USEROP_TABLE');
if (!databaseUrl || !table || !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(table)) {
  console.error('db-event-watcher: DATABASE_URL and a valid CHAIN_INDEX_USEROP_TABLE are needed in the facilitator .env');
  process.exit(2);
}
const { Client } = require(path.join(facDir, 'node_modules/pg'));
const quoted = table.split('.').map((p) => `"${p}"`).join('.');
const sql = `SELECT '0x' || encode(user_op_hash, 'hex') AS user_op_hash, tx_hash, block_number::bigint AS block FROM ${quoted} WHERE user_op_hash = ANY($1::bytea[])`;

const getJson = (url) => new Promise((resolve) => {
  http.get(url, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }).on('error', () => resolve(null));
});

(async () => {
  const stream = fs.createWriteStream(path.resolve(out), { flags: 'a' });
  const client = new Client({ connectionString: databaseUrl, statement_timeout: 3000, query_timeout: 4000 });
  await client.connect();
  const owner = new Map(); // userOpHash -> payment index
  const seen = new Set();
  const started = Date.now();
  let stop = false;
  let lastStart = started;
  const finish = () => { stop = true; };
  process.on('SIGTERM', finish);
  process.on('SIGINT', finish);
  console.log(`db-event-watcher: ${table} every ${interval}ms, proxy ${proxy}`);

  while (!stop && Date.now() - started < maxMs) {
    const pollStart = Date.now();
    const reg = await getJson(`${proxy}/__payments`);
    for (const p of reg?.payments ?? []) owner.set(p.userOpHash.toLowerCase(), p.index);
    const waiting = [...owner.keys()].filter((h) => !seen.has(h));
    if (waiting.length > 0) {
      try {
        const rows = (await client.query(sql, [waiting.map((h) => `\\x${h.slice(2)}`)])).rows;
        const seenMs = Date.now();
        for (const r of rows) {
          const h = r.user_op_hash.toLowerCase();
          if (seen.has(h)) continue;
          seen.add(h);
          stream.write(`${JSON.stringify({ payment: owner.get(h), userOpHash: h, seenMs, seenAt: new Date(seenMs).toISOString(), afterPollStartMs: lastStart, tx: r.tx_hash.trim().toLowerCase(), block: Number(r.block) })}\n`);
        }
      } catch (e) {
        console.error(`db-event-watcher: query failed (${e.message}); retrying`);
      }
    }
    lastStart = pollStart;
    const wait = interval - (Date.now() - pollStart);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  console.log(`db-event-watcher: stopped, ${seen.size} of ${owner.size} registered payments seen`);
  await client.end().catch(() => {});
  stream.end(() => process.exit(0));
})().catch((e) => { console.error(`db-event-watcher: ${e.message}`); process.exit(1); });
