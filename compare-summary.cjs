// Builds the before/after table from the files compare-ledger.sh wrote.
//   node compare-summary.cjs <results-dir> <facilitator-dir>
'use strict';
const fs = require('fs');
const path = require('path');

const [, , dir, facDir] = process.argv;
const { createPublicClient, http } = require(path.join(facDir, 'node_modules/viem'));
const { Client } = require(path.join(facDir, 'node_modules/pg'));

const LABEL = {
  A: 'branch, ledger ON (cap 100)',
  C: 'branch, ledger OFF',
  D: 'branch, ledger ON (cap 100)',
  B: 'develop (before the fix)',
};

// ⭐ What confirmed the settles is read from the facilitator's own boot line, not assumed from the config letter:
// a branch run inherits SETTLE_CONFIRMATION_MODE from the facilitator .env unless the config sets it.
function confirmationOf(cfg, runs) {
  const logs = runs.map((_, i) => path.join(dir, `facilitator-${cfg}-${i + 1}.log`)).filter((f) => fs.existsSync(f));
  if (logs.length === 0) return '';
  const indexer = logs.some((f) => /settle confirmation=indexer/.test(fs.readFileSync(f, 'utf8')));
  return indexer ? ' + indexer confirmation' : '';
}
const labelOf = (cfg, runs) => LABEL[cfg] + confirmationOf(cfg, runs);

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const sec = (ms) => (ms / 1000).toFixed(1) + 's';

function parse(file) {
  const text = fs.readFileSync(file, 'utf8');
  const num = (k) => {
    const m = text.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm'));
    return m ? Number(m[1]) : null;
  };
  return {
    total: num('total'),
    success: num('success'),
    p50: num('p50'),
    p95: num('p95'),
    wall: num('wall'),
    hashes: [...text.matchAll(/txHash=(0x[0-9a-f]{64})/g)].map((m) => m[1]),
  };
}

/** The settings each config ran with (record-settings.cjs): comparing two runs means little without them. */
function printSettings(byCfg, labelOf) {
  const lines = [];
  let stale = false;
  for (const cfg of ['B', 'C', 'A', 'D']) {
    const runs = byCfg[cfg];
    if (!runs) continue;
    const files = runs.map((_, i) => path.join(dir, `settings-${cfg}-${i + 1}.json`)).filter((f) => fs.existsSync(f));
    if (files.length === 0) continue;
    const all = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
    const uniq = (xs) => [...new Set(xs.map((x) => (x === null || x === undefined ? 'n/a' : String(x))))].join(' / ');
    const indexer = all.some((s) => s.facilitator.confirmation === 'indexer');
    stale = stale || all.some((s) => s.rindexer.stale);
    lines.push(
      `| ${labelOf(cfg, runs)} | ${uniq(all.map((s) => s.facilitator.confirmation))} | ` +
        `${indexer ? uniq(all.map((s) => (s.facilitator.indexPollMs === null ? null : `${s.facilitator.indexPollMs}ms`))) : '-'} | ` +
        `${indexer ? uniq(all.map((s) => (s.facilitator.indexTimeoutMs === null ? null : `${s.facilitator.indexTimeoutMs}ms`))) : '-'} | ` +
        `${indexer ? uniq(all.map((s) => s.rindexer.blockPollFrequency)) : '-'} |`,
    );
  }
  if (lines.length === 0) return;
  console.log('\nSettings each config ran with (read from the facilitator\'s boot line and rindexer.yaml):\n');
  console.log('| Config | Confirmation | Facilitator polls the DB every | Index wait before RPC | rindexer block_poll_frequency |');
  console.log('|---|---|---|---|---|');
  lines.forEach((l) => console.log(l));
  if (stale) console.log('\n⚠️ rindexer was started before its rindexer.yaml/.env last changed: it was still running the old settings. Restart it for a change there to apply.');
}

async function blocksOf(hashes) {
  if (hashes.length === 0) return null;
  const client = createPublicClient({ transport: http(process.env.RPC_URL || 'https://rpc-test.qday.info') });
  const perBlock = new Map();
  for (let i = 0; i < hashes.length; i += 20) {
    const batch = hashes.slice(i, i + 20);
    const receipts = await Promise.all(batch.map((h) => client.getTransactionReceipt({ hash: h }).catch(() => null)));
    for (const r of receipts) if (r) perBlock.set(r.blockNumber, (perBlock.get(r.blockNumber) ?? 0) + 1);
  }
  const counts = [...perBlock.values()];
  return counts.length ? { blocks: counts.length, max: Math.max(...counts) } : null;
}

// One row per config: the median across runs of each method's call count.
function printRpcTable(byCfg, labelOf) {
  const perCfg = [];
  for (const cfg of ['B', 'C', 'A', 'D']) {
    const runs = byCfg[cfg];
    if (!runs) continue;
    const stats = runs
      .map((_, i) => path.join(dir, `rpc-${cfg}-${i + 1}.json`))
      .filter((f) => fs.existsSync(f))
      .map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
    if (stats.length === 0) continue;
    const orders = runs[0].total || 1;
    perCfg.push({ cfg, label: labelOf(cfg, runs), orders, stats });
  }
  if (perCfg.length === 0) return;

  const methods = [...new Set(perCfg.flatMap((c) => c.stats.flatMap((s) => Object.keys(s.byMethod))))].sort();
  console.log('\nJSON-RPC calls from the facilitator during the load (median over runs; per order = total / orders):\n');
  console.log(`| Config | total | per order | ${methods.join(' | ')} |`);
  console.log(`|---|---|---|${methods.map(() => '---').join('|')}|`);
  for (const c of perCfg) {
    const total = median(c.stats.map((s) => s.total));
    const cells = methods.map((m) => median(c.stats.map((s) => s.byMethod[m] ?? 0)));
    console.log(`| ${c.label} | ${total} | ${(total / c.orders).toFixed(1)} | ${cells.join(' | ')} |`);
  }
  console.log('\nBackground jobs of the facilitator (nonce reconciler, ...) are counted too; the boot-time calls are not.');
}

(async () => {
  const files = fs.readdirSync(dir).filter((f) => /^[ABCD]-\d+\.txt$/.test(f));
  const byCfg = {};
  for (const f of files) (byCfg[f[0]] ||= []).push(parse(path.join(dir, f)));

  const rows = [];
  for (const cfg of ['B', 'C', 'A', 'D']) {
    const runs = byCfg[cfg];
    if (!runs) continue;
    const b = await blocksOf(runs.flatMap((r) => r.hashes));
    rows.push(
      `| ${labelOf(cfg, runs)} | ${runs.length} | ${runs.map((r) => `${r.success}/${r.total}`).join(', ')} | ` +
        `${sec(median(runs.map((r) => r.wall)))} | ${sec(median(runs.map((r) => r.p50)))} | ` +
        `${sec(median(runs.map((r) => r.p95)))} | ${b ? `${b.blocks} / max ${b.max}` : '-'} |`,
    );
  }

  console.log('| Config | Runs | success per run | wall (median) | p50 | p95 | blocks (all runs) / max tx per block |');
  console.log('|---|---|---|---|---|---|---|');
  rows.forEach((r) => console.log(r));

  printRpcTable(byCfg, labelOf);
  printSettings(byCfg, labelOf);

  if (byCfg.A || byCfg.D) {
    try {
      const env = fs.readFileSync(path.join(facDir, '.env'), 'utf8').split('\n').find((l) => l.startsWith('DATABASE_URL='));
      const c = new Client({ connectionString: env.slice('DATABASE_URL='.length).trim() });
      await c.connect();
      const r = await c.query('select status, count(*)::int n from facilitator.signer_nonce_ledger group by 1 order by 1');
      await c.end();
      console.log('\nNonce ledger after the run (all time): ' + r.rows.map((x) => `${x.status}=${x.n}`).join(', '));
      console.log('Expect only `confirmed`. Any `superseded` / `filled` / `reusable` means the reconciler had to step in: read facilitator-A-*.log.');
    } catch (e) {
      console.log('\n(ledger check skipped: ' + e.message + ')');
    }
  }
})();
