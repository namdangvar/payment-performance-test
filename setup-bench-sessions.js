// Tạo N spending sessions trên một qpass và ghi bench-sessions.json.
// Cần: mobile-approver.js (trong qday-payment-e2e-harness/scripts/) đang chạy trong terminal khác.
//
// Cách dùng:
//   node setup-bench-sessions.js <N> [--output <đường dẫn>]
//   Ví dụ: node setup-bench-sessions.js 10
//          node setup-bench-sessions.js 100 --output ./bench-sessions.json
//
// Đọc config từ .env trong thư mục này (copy từ harness .env):
//   WALLET_API_URL, JWT_SECRET, OWNER_PRIVATE_KEY, ACCOUNT_ID, QPASS_ID (bắt buộc)
//   BENCH_PER_TX_CAP   — atomic units, mặc định "1000000" (1 tUSD8)
//   BENCH_TOTAL_CAP    — atomic units, mặc định "1000000" (1 tUSD8)
//   BENCH_EXPIRES_IN   — giây, mặc định 3600 (1 giờ)

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Pull lib.js helpers from the harness rather than duplicating them.
const lib = require('../qday-payment-e2e-harness/scripts/lib');
const { loadEnv, requireEnv, call, sleep } = lib;

const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
const jwt = require('jsonwebtoken');

const POLL_MS = 3_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1_000;

function parseArgs() {
  const args = process.argv.slice(2);
  const n = parseInt(args[0], 10);
  if (!n || n <= 0) {
    console.error('usage: node setup-bench-sessions.js <N> [--output <path>]');
    process.exit(1);
  }
  const outputIdx = args.indexOf('--output');
  return { n, output: outputIdx >= 0 ? args[outputIdx + 1] : null };
}

// Load .env from this directory (not harness root)
function loadLocalEnv() {
  const file = path.join(__dirname, '.env');
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

async function waitForConfirmation(api, token, requestId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const req = await call(`${api}/v1/approval-requests/${encodeURIComponent(requestId)}`, { token });
    if (req.status === 'confirmed') return req;
    if (req.status === 'failed') throw new Error(`request ${requestId} failed on chain`);
    if (req.status === 'expired') throw new Error(`request ${requestId} expired before approval`);
    await sleep(POLL_MS);
  }
  throw new Error(`request ${requestId} did not confirm within ${POLL_TIMEOUT_MS / 1000}s`);
}

async function getPermissionId(api, token, signetpassId, sessionGrantId) {
  // wallet-api renamed qpass → signetpass; query param is `signetpassId`.
  const sessions = await call(
    `${api}/v1/sessions?limit=200&signetpassId=${encodeURIComponent(signetpassId)}`, { token },
  );
  const items = Array.isArray(sessions) ? sessions : (sessions.items ?? []);
  const found = items.find((s) => s.id === sessionGrantId);
  if (!found) throw new Error(`session ${sessionGrantId} not found after confirmation`);
  if (!found.permissionId) throw new Error(`session ${sessionGrantId} confirmed but has no permissionId yet`);
  return { permissionId: found.permissionId, walletAddress: found.walletAddress };
}

async function createOneSession(api, token, signetpassId, caps, index) {
  const agentId = crypto.randomUUID();
  const privateKey = generatePrivateKey();
  const sessionKey = privateKeyToAccount(privateKey);

  console.log(`[${index}] tạo session — agentId=${agentId}  key=${sessionKey.address}`);

  // ⛔ Agents are no longer minted inside spendingSession.open — link first (off-chain), then open.
  // One active session per agent, so each bench session needs its own agent id.
  await call(`${api}/v1/agents`, {
    method: 'POST', token,
    body: {
      signetpassId,
      agentId,
      name: `bench-agent-${index}`,
      vendor: { agent: 'pay-performance-test', entrypoint: 'setup-bench-sessions' },
    },
  });

  const request = await call(`${api}/v1/approval-requests`, {
    method: 'POST', token,
    body: {
      kind: 'spendingSession.open',
      input: {
        // ⛔ wallet-api expects `signetpassId` (formerly `qpassId`).
        signetpassId, agentId,
        sessionPublicKey: sessionKey.address,
        taskSummary: `bench session ${index}`,
        perTxCapAtomic: caps.perTx,
        totalCapAtomic: caps.total,
        expiresInSeconds: caps.expiresIn,
      },
    },
  });

  const hash = request.payload?.sessionUserOpHash;
  if (!hash) throw new Error(`request ${request.id} không có sessionUserOpHash`);

  const signature = await sessionKey.signMessage({ message: { raw: hash } });
  await call(`${api}/v1/approval-requests/${encodeURIComponent(request.id)}/session-signature`, {
    method: 'POST', token, body: { signature },
  });

  console.log(`[${index}] chờ mobile-approver duyệt (requestId=${request.id})…`);
  const confirmed = await waitForConfirmation(api, token, request.id);

  const { sessionGrantId } = confirmed;
  if (!sessionGrantId) throw new Error(`request ${request.id} confirmed nhưng không có sessionGrantId`);

  const { permissionId, walletAddress } = await getPermissionId(api, token, signetpassId, sessionGrantId);
  console.log(`[${index}] ✓  sessionGrantId=${sessionGrantId}  permissionId=${permissionId}`);

  return { sessionGrantId, permissionId, walletAddress, sessionKeyAddress: sessionKey.address, sessionPrivateKey: privateKey };
}

async function main() {
  const { n, output } = parseArgs();

  const env = loadLocalEnv();
  // SIGNETPASS_ID preferred; QPASS_ID kept as alias for older .env files.
  const required = ['WALLET_API_URL', 'JWT_SECRET', 'OWNER_PRIVATE_KEY', 'ACCOUNT_ID'];
  const missing = required.filter((k) => !env[k] && !process.env[k]);
  if (missing.length) {
    console.error(`Error: .env is missing: ${missing.join(', ')}`);
    console.error('Copy .env.example to .env and fill in the values.');
    process.exit(1);
  }
  const get = (k, d) => process.env[k] ?? env[k] ?? d;
  const signetpassId = get('SIGNETPASS_ID') || get('QPASS_ID');
  if (!signetpassId) {
    console.error('Error: .env is missing SIGNETPASS_ID (or legacy QPASS_ID)');
    process.exit(1);
  }

  const api = get('WALLET_API_URL').replace(/\/$/, '');
  const owner = privateKeyToAccount(get('OWNER_PRIVATE_KEY'));
  const token = jwt.sign({ sub: get('ACCOUNT_ID'), address: owner.address }, get('JWT_SECRET'), { expiresIn: '12h' });

  const caps = {
    perTx: get('BENCH_PER_TX_CAP', '1000000'),
    total: get('BENCH_TOTAL_CAP', '1000000'),
    expiresIn: parseInt(get('BENCH_EXPIRES_IN', '3600'), 10),
  };

  const outputFile = output ?? path.join(__dirname, 'bench-sessions.json');

  let existing = [];
  if (fs.existsSync(outputFile)) {
    try { existing = JSON.parse(fs.readFileSync(outputFile, 'utf8')); } catch { existing = []; }
    console.log(`(resuming — ${existing.length} session(s) already in ${outputFile})`);
  }

  console.log(`Creating ${n} sessions on signetpass ${signetpassId}`);
  console.log(`Caps: perTx=${caps.perTx} total=${caps.total} expires=${caps.expiresIn}s`);
  console.log('Make sure mobile-approver.js is running in another terminal.\n');

  for (let i = 0; i < n; i++) {
    const entry = await createOneSession(api, token, signetpassId, caps, i + 1).catch((e) => {
      console.error(`[${i + 1}] ⛔ failed: ${e.message}`);
      return null;
    });
    if (!entry) continue;
    existing.push(entry);
    fs.writeFileSync(outputFile, JSON.stringify(existing, null, 2) + '\n');
    console.log(`   → saved ${existing.length} session(s) to ${outputFile}\n`);
  }

  console.log(`\nDone — ${existing.length}/${n} sessions written to ${outputFile}`);
}

main().catch((e) => { console.error('\n⛔', e.message); process.exit(1); });
