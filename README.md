# pay-performance-test

QDay payment (x402) benchmark. There are **two kinds of test**:

| | Type 1 — Local facilitator | Type 2 — Running merchant |
|---|---|---|
| Purpose | Compare facilitator branches | Measure latency against a merchant that is already up |
| Facilitator | Script starts one locally (port 3032) | Uses whatever facilitator that merchant talks to |
| Merchant | Script starts `merchant-demo` | Set `MERCHANT_URL` (local or remote) |
| Branch compare | Yes (`CONFIGS=A C B`) | No |

Both need a **session file** (one spending session per concurrent payment).

> Do not put real secrets, private keys, or environment hostnames in this README or in commits. Keep them in local `.env` only (git-ignored).

---

## Shared setup (once)

### 1. Install

```bash
cd payment/pay-performance-test
npm install
cp .env.example .env
```

Fill `.env` from your local harness / wallet-api config (never commit `.env`):

| Variable | Meaning |
|---|---|
| `WALLET_API_URL` | Local wallet-api base URL (default port `3003`) |
| `JWT_SECRET` | Same value wallet-api uses |
| `OWNER_PRIVATE_KEY` | Funded owner key (local only) |
| `ACCOUNT_ID` | Account UUID (JWT `sub`) |
| `QPASS_ID` | Qpass UUID |
| `QDAY_ENV` | e.g. `develop` for the local test chain |

### 2. Services needed to **create sessions**

| Service | Typical local port | Notes |
|---|---|---|
| Postgres | per wallet-api `.env` | e.g. `docker start qday-pg` |
| Redis | `6379` | `redis-server` |
| wallet-api | `3003` | `cd ../qday-payment-wallet-api && pnpm start:dev` |
| mobile-approver | — | `cd ../qday-payment-e2e-harness && npm run approver -- <ACCOUNT_ID>` |

Approver must print that it is waiting for approval requests before you create sessions.

### 3. Create sessions

```bash
cd payment/pay-performance-test

# Remove an old file if present (script appends; expired sessions at the start of the file will fail the run)
rm -f ./fresh-sessions.json

# Create N new sessions (6h TTL). Approver must be running.
# N here must be >= the N you pass to compare-ledger / bench-pay later.
BENCH_EXPIRES_IN=21600 node setup-bench-sessions.js 10 --output ./fresh-sessions.json
```

- ~20s per session (approve + on-chain). 10 sessions ≈ 3–4 minutes.
- Session paymaster must match the facilitator/merchant you will hit (mismatch → `wrong_paymaster`).
- Expired / nearly expired sessions → `session_expiring`. Always use a fresh file, or keep only the newest entries at the end.

---

## Type 1 — Local facilitator (branch compare)

`compare-ledger.sh` **builds and starts** its own facilitator and merchant-demo, then fires N payments. Use this to compare before/after a code change.

**Do not set `MERCHANT_URL`.** `CONFIGS` / `BRANCH` only apply here.

### Extra requirements

- `qday-payment-facilitator` next to this folder, with a working `.env` (DB, Redis, funded signer)
- `qday-payment-merchant-demo` with `.env`
- Facilitator working tree **clean** (script runs `git checkout`)
- **Stop** facilitator `pnpm start:dev` / `nest --watch` before running
- Redis alive marker for the merchant the script starts:

```bash
# payTo = receive address from the merchant boot log
redis-cli SET merchant:alive:<payTo-lowercase> 1 EX 21600
```

### Run

```bash
cd payment/pay-performance-test

# Small / smoke (default CONFIGS="A C B")
N=10 REPS=1 SESSIONS=./fresh-sessions.json ./compare-ledger.sh

# Full-ish compare
N=100 REPS=3 SESSIONS=./fresh-sessions.json ./compare-ledger.sh

# Only two configs on the same branch (ledger ON vs OFF)
CONFIGS="A C" N=50 REPS=1 SESSIONS=./fresh-sessions.json ./compare-ledger.sh

# Your feature branch vs develop
BRANCH=<your-feature-branch> CONFIGS="A B" N=10 REPS=1 SESSIONS=./fresh-sessions.json ./compare-ledger.sh
```

| Config | Meaning |
|---|---|
| `A` | Branch `BRANCH`, ledger ON |
| `C` | Same branch, ledger OFF |
| `B` | `develop` |

Results land in `compare-results/<timestamp>/` (`summary.md`, facilitator/merchant logs, timings).

---

## Type 2 — Running merchant (no branch compare)

Does **not** start a local facilitator and does **not** use `CONFIGS` / `BRANCH`.  
Hits a merchant that is already running (your local `merchant-demo`, or any deployed merchant that returns HTTP 402).

### Examples

Local merchant-demo (default item `haiku`, price `10000` atomic = 0.01):

```bash
cd payment/pay-performance-test

MERCHANT_URL='http://localhost:3004/items/haiku' \
SESSIONS=./fresh-sessions.json \
N=3 REPS=1 \
ORDER_PRICE_ATOMIC=10000 \
SKIP_SESSION_CHECK=1 \
./compare-ledger.sh
```

Remote / shared environment (replace with your own URL and price):

```bash
MERCHANT_URL='https://<merchant-host>/<402-path>' \
SESSIONS=./fresh-sessions.json \
N=3 REPS=1 \
ORDER_PRICE_ATOMIC=<price-atomic> \
SKIP_SESSION_CHECK=1 \
./compare-ledger.sh
```

Or call `bench-pay` directly:

```bash
node bench-pay.js ./fresh-sessions.json "$MERCHANT_URL"
```

| Variable | Meaning |
|---|---|
| `MERCHANT_URL` | Any URL that returns **402** with `qday:erc4337` |
| `SESSIONS` | Session file still valid, correct paymaster |
| `N` | Concurrent payments (≤ sessions in the file) |
| `REPS` | How many times to repeat |
| `ORDER_PRICE_ATOMIC` | Merchant price in atomic units (read from the 402 `amount`) |
| `SKIP_SESSION_CHECK=1` | Skip local wallet-api session listing (use when sessions are not in that DB) |

Sanity-check first:

```bash
curl -i "$MERCHANT_URL"
# expect: HTTP 402 + scheme qday:erc4337
```

For a local merchant you still need that environment’s facilitator (and usually Redis `merchant:alive:<payTo>`) already running.

---

## Reading results

```
total / success / failure
p50 / p95 / wall
```

- `success` should equal `N` (or be very close). Mass failures → fix setup (table below), not a compare result.
- `wall` ≈ slowest payment when running concurrently.

Example:

```
[  1] OK   start=… 402=+45ms signed=+120ms done=+4321ms txHash=0x…
─── Summary ───
total: 3  success: 3  failure: 0  p50: …  wall: …
```

---

## Common errors

| Error | Cause | Fix |
|---|---|---|
| Approver `fetch failed` | wallet-api down / Redis / Postgres down | Start Redis → Postgres → wallet-api, then approver |
| `not found on wallet-api` | Session file not in local DB | `SKIP_SESSION_CHECK=1` (type 2) or create sessions on the wallet-api you are using |
| `wrong_paymaster` | Session installed with an old paymaster | Create new sessions with the current paymaster |
| `session_expiring` | Sessions expired, or old ones sit at the **start** of the file | `rm` the file → recreate; or keep only the end: `a.slice(-10)` |
| `not enough tUSD8` | Wallet low | Top up the wallet printed in the log |
| `merchant_not_alive` | Missing Redis key | `SET merchant:alive:<payTo> 1 EX 21600` |
| `payment_expired` / first-seen | Reusing sessions after a failed run | Script clears this; or `CLEAR_FIRST_SEEN=1` |

---

## Minimal checklist

**Type 1 (local branch compare)** — no `MERCHANT_URL`

1. [ ] `.env` filled in (local only)  
2. [ ] Fresh sessions: `setup-bench-sessions.js` count ≥ `N`  
3. [ ] Facilitator watch mode stopped, git clean  
4. [ ] Redis marker `merchant:alive:…`  
5. [ ] `BRANCH=… CONFIGS="A B" N=… SESSIONS=… ./compare-ledger.sh`

**Type 2 (merchant already running)** — no `CONFIGS` / `BRANCH`

1. [ ] Fresh sessions, paymaster matches that merchant’s facilitator  
2. [ ] `curl "$MERCHANT_URL"` → 402  
3. [ ] `MERCHANT_URL=… SESSIONS=… N=… ORDER_PRICE_ATOMIC=… SKIP_SESSION_CHECK=1 ./compare-ledger.sh`

---

## Main files

| File | Role |
|---|---|
| `setup-bench-sessions.js` | Build the session pool |
| `bench-pay.js` | Fire N payments, print timings |
| `compare-ledger.sh` | Type 1 (no `MERCHANT_URL`) or type 2 (`MERCHANT_URL` set) |
| `check-sessions.cjs` / `check-funds.cjs` | Prechecks before a run |

> Session files hold private keys — **do not commit or share**. They are git-ignored. Delete when you no longer need them.
