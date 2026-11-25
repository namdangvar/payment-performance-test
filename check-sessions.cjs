// Fails fast when the first N sessions in a sessions file can no longer pay.
//   node check-sessions.cjs <sessions-file> <N> [min-remaining-minutes]
//
// Asks wallet-api (same .env as setup-bench-sessions.js) for each session's status and expiry. A session is
// usable only if it is `active`, not revoked on or off chain, and expires later than `min-remaining-minutes`
// from now (default 30): a run that straddles the expiry makes the last orders fail and looks like a code bug.
// Remaining spend cap is not exposed by the API, so it is not checked.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { privateKeyToAccount } = require('viem/accounts');

const [, , file, nArg, minArg] = process.argv;
const n = Number(nArg);
const minRemainingMin = Number(minArg ?? 30);

function loadEnv() {
  const envFile = path.join(__dirname, '.env');
  const vars = {};
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      vars[t.slice(0, t.indexOf('=')).trim()] = t.slice(t.indexOf('=') + 1).trim();
    }
  }
  return (key) => process.env[key] ?? vars[key];
}

async function main() {
  const get = loadEnv();
  const missing = ['WALLET_API_URL', 'JWT_SECRET', 'OWNER_PRIVATE_KEY', 'ACCOUNT_ID', 'QPASS_ID'].filter((k) => !get(k));
  if (missing.length) throw new Error(`pay-performance-test/.env is missing: ${missing.join(', ')}`);

  const api = get('WALLET_API_URL').replace(/\/$/, '');
  const owner = privateKeyToAccount(get('OWNER_PRIVATE_KEY'));
  const token = jwt.sign({ sub: get('ACCOUNT_ID'), address: owner.address }, get('JWT_SECRET'), { expiresIn: '10m' });

  const wanted = JSON.parse(fs.readFileSync(file, 'utf8')).slice(0, n);
  const byId = new Map();
  let cursor;
  do {
    const url = `${api}/v1/sessions?limit=200&signetpassId=${encodeURIComponent(get('QPASS_ID'))}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`wallet-api ${res.status} on GET /v1/sessions`);
    const body = await res.json();
    for (const s of Array.isArray(body) ? body : (body.items ?? [])) byId.set(s.id, s);
    cursor = Array.isArray(body) ? undefined : body.nextCursor;
  } while (cursor);

  const deadline = Date.now() + minRemainingMin * 60_000;
  const problems = [];
  let earliest = Infinity;
  wanted.forEach((w, i) => {
    const s = byId.get(w.sessionGrantId);
    const label = `#${i + 1} ${w.sessionGrantId.slice(0, 8)}`;
    if (!s) return problems.push(`${label}: not found on wallet-api`);
    if (s.status !== 'active') return problems.push(`${label}: status=${s.status}`);
    if (s.revoked || s.onchainRevoked) return problems.push(`${label}: revoked`);
    const exp = Date.parse(s.expiresAt);
    earliest = Math.min(earliest, exp);
    if (!(exp > deadline)) {
      const left = Math.round((exp - Date.now()) / 60_000);
      problems.push(`${label}: ${left > 0 ? `expires in ${left} min (< ${minRemainingMin})` : `expired ${-left} min ago`}`);
    }
  });

  if (problems.length) {
    console.error(`${problems.length}/${wanted.length} sessions are not usable:`);
    problems.slice(0, 10).forEach((p) => console.error(`  - ${p}`));
    if (problems.length > 10) console.error(`  … and ${problems.length - 10} more`);
    process.exit(1);
  }
  const left = Math.round((earliest - Date.now()) / 60_000);
  console.log(`sessions ok: ${wanted.length} active, the earliest expires in ${left} min (${new Date(earliest).toLocaleString()})`);
}

main().catch((e) => {
  console.error(`session check failed: ${e.message}`);
  process.exit(2);
});
