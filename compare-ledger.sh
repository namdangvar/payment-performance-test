#!/usr/bin/env bash
# Compares settle throughput before and after the nonce ledger, on the same sessions.
#
#   A  branch $BRANCH (default feat/parallel-settle-nonce-ledger), NONCE_LEDGER_ENABLED=true, SIGNER_MAX_INFLIGHT=200,
#      SETTLE_CONFIRMATION_MODE=indexer (needs CHAIN_INDEX_USEROP_TABLE in the facilitator .env; overrides .env)
#   C  same branch, ledger OFF (isolates the earlier PR #24 changes)
#   B  develop (before everything)
#   D  same as A (ledger ON + indexer) — kept for older docs/commands
#   E  same branch, ledger OFF and confirmation through RPC only (SETTLE_CONFIRMATION_MODE=rpc, no indexer)
#
# Usage:   ./compare-ledger.sh
# Options (env):  BRANCH=<branch with the ledger>  N=100  REPS=2  CONFIGS="A C B"  SESSIONS=<file>  FAC_PORT=3032  MER_PORT=3034
#                 MIN_REMAINING_MIN=30 (sessions must live this long)  SKIP_SESSION_CHECK=1
#                 MIN_ALIVE_MIN=30 (Redis merchant:alive marker must live this long)  SKIP_FUNDS_CHECK=1
#                 COUNT_RPC=1 (count the JSON-RPC calls the facilitator makes; 0 to turn off)  RPC_PORT=3099
#                 RPC_CALL_LOG=1 (with COUNT_RPC=1: also write rpc-calls-<cfg>-<rep>.jsonl, one line per call tagged with the
#                                payment it served and how long the RPC took; 0 to turn off. Fields: see rpc-counter-proxy.cjs)
#                 DB_EVENT_LOG=1 (with RPC_CALL_LOG=1: db-event-watcher.cjs also records when each payment's event first shows up in the
#                                index table, index-seen-<cfg>-<rep>.jsonl; it is one more reader of that table: 0 to turn off)
#                 INDEX_POLL_MS=<ms> (how often the facilitator polls the index table while payments wait; default: what its .env says.
#                                Passed to the facilitator as SETTLE_CHAIN_INDEX_POLL_MS. Only configs that confirm through the index use it)
#                 Every run records the settings it ran with (settings-<cfg>-<rep>.json, and a "Settings" table in summary.md): the facilitator's
#                 own boot line, and rindexer's block_poll_frequency with a warning when rindexer was not restarted after its config changed.
#                 Every run then writes report-<cfg>-<rep>.csv/.json: one row per payment with its ids and every timestamp (payment-report.cjs)
#                 UPSTREAM_RPC_URL=<rpc> (default: the first RPC_URLS entry of the facilitator .env)
#                 CLEAR_FIRST_SEEN=1 (delete the facilitator's qday-aa:first-seen:* Redis markers before each run; 0 to keep them)
#                 SIGN_RPC_CONCURRENCY=40 (default; bench-pay cap on parallel signing reads, also caps submits at 100 in flight; 0 = fire everything at once)
#                 MERCHANT_URL=<402 url>  call this already-running merchant instead of starting a local facilitator and
#                                merchant-demo. Measures completion time only (p50, p95, wall). No JSON-RPC counts.
#                                Example: MERCHANT_URL=https://host/items/haiku N=100 REPS=1 ./compare-ledger.sh
#
# Starts its OWN facilitator and merchant-demo on FAC_PORT / MER_PORT, so your dev servers are left alone.
# The only thing touched in your checkout is `git checkout` (for B) and `dist/`; the original branch is restored on exit.
# Run it while nothing else is paying: every config signs with the same facilitator key.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
FAC=$ROOT/qday-payment-facilitator
MER=$ROOT/qday-payment-merchant-demo
BRANCH=${BRANCH:-feat/parallel-settle-nonce-ledger}

N=${N:-100}
REPS=${REPS:-2}
CONFIGS=${CONFIGS:-"A C B"}
SESSIONS=${SESSIONS:-$HERE/compare-sessions.json}
FAC_PORT=${FAC_PORT:-3032}
MER_PORT=${MER_PORT:-3034}
COUNT_RPC=${COUNT_RPC:-1}
RPC_CALL_LOG=${RPC_CALL_LOG:-1}
DB_EVENT_LOG=${DB_EVENT_LOG:-1}
INDEX_POLL_MS=${INDEX_POLL_MS:-}
# ⚠️ Without this, bench-pay fires every payment at once and a public RPC times out inside /verify (reported as
# `malformed`), so the failures say nothing about the code under test. 40 also turns on the 100-in-flight submit cap.
export SIGN_RPC_CONCURRENCY=${SIGN_RPC_CONCURRENCY:-40}
RPC_PORT=${RPC_PORT:-3099}
OUT=$HERE/compare-results/$(date +%Y%m%d-%H%M%S)

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# ── preconditions ────────────────────────────────────────────────────────────
[ -f "$SESSIONS" ] || die "sessions file not found: $SESSIONS"
node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1]));if(a.length<+process.argv[2]){console.error("only "+a.length+" sessions, need "+process.argv[2]);process.exit(1)}' "$SESSIONS" "$N" \
  || die "not enough sessions in $SESSIONS"

# Already-deployed merchant: time the payments, do not boot a facilitator or count its RPC calls.
if [ -n "${MERCHANT_URL:-}" ]; then
  export QDAY_ENV=${QDAY_ENV:-develop}
  export SIGN_RPC_CONCURRENCY=${SIGN_RPC_CONCURRENCY:-40}
  if [ "${SKIP_SESSION_CHECK:-0}" != "1" ]; then
    say "checking sessions (needs at least ${MIN_REMAINING_MIN:-30} min of life left)"
    (cd "$HERE" && node check-sessions.cjs "$SESSIONS" "$N" "${MIN_REMAINING_MIN:-30}") \
      || die "fix the sessions first, or SKIP_SESSION_CHECK=1"
  fi
  if [ "${SKIP_FUNDS_CHECK:-0}" != "1" ]; then
    say "checking the wallet can pay for the whole run"
    (cd "$HERE" && node check-funds.cjs "$SESSIONS" "$N" "$REPS") \
      || die "not enough tUSD8 for this run (price defaults to 10000 atomic; set ORDER_PRICE_ATOMIC). SKIP_FUNDS_CHECK=1 to skip"
  fi
  mkdir -p "$OUT"
  node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync(process.argv[1]));fs.writeFileSync(process.argv[2],JSON.stringify(a.slice(0,+process.argv[3])))' "$SESSIONS" "$OUT/.sessions.json" "$N"
  trap 'rm -f "$OUT/.sessions.json"' EXIT
  for r in $(seq 1 "$REPS"); do
    say "remote merchant · run $r/$REPS"
    # Same as the local path: stale qday-aa:first-seen:* markers (e.g. from an earlier N=10) refuse
    # the same (account, nonce) as payment_expired after 90s. MERCHANT_URL used to skip this clear.
    if [ "${CLEAR_FIRST_SEEN:-1}" = "1" ]; then
      node "$HERE/clear-first-seen.cjs" "$FAC" || die "could not clear the first-seen markers (to skip: CLEAR_FIRST_SEEN=0)"
    fi
    (cd "$HERE" && node bench-pay.js "$OUT/.sessions.json" "$MERCHANT_URL") | tee "$OUT/remote-$r.txt"
    if [ "$(grep -E '^success:' "$OUT/remote-$r.txt" | awk '{print $2}')" = "0" ]; then
      die "no payment succeeded, see $OUT/remote-$r.txt"
    fi
  done
  say "summary"
  echo "merchant: $MERCHANT_URL"
  grep -E '^(total|success|failure|min|max|avg|p50|p95|p99|wall):' "$OUT"/remote-*.txt
  echo "raw results: $OUT"
  exit 0
fi

if [ "${SKIP_SESSION_CHECK:-0}" != "1" ]; then
  say "checking sessions (needs at least ${MIN_REMAINING_MIN:-30} min of life left)"
  set +e
  (cd "$HERE" && node check-sessions.cjs "$SESSIONS" "$N" "${MIN_REMAINING_MIN:-30}")
  rc=$?
  set -e
  case $rc in
    0) ;;
    1) die "fix the sessions first (create new ones with setup-bench-sessions.js), or lower MIN_REMAINING_MIN" ;;
    *) die "could not check sessions (is wallet-api up?). To run anyway: SKIP_SESSION_CHECK=1 ./compare-ledger.sh" ;;
  esac
fi
if [ "${SKIP_FUNDS_CHECK:-0}" != "1" ]; then
  say "checking the wallet can pay for the whole run"
  ncfg=$(echo $CONFIGS | wc -w | tr -d ' ')
  set +e
  (cd "$HERE" && node check-funds.cjs "$SESSIONS" "$N" "$((REPS * ncfg))" "$MER/.env")
  rc=$?
  set -e
  case $rc in
    0) ;;
    1) die "not enough tUSD8 for this run" ;;
    *) die "could not read the balance (is the RPC up?). To run anyway: SKIP_FUNDS_CHECK=1 ./compare-ledger.sh" ;;
  esac
fi
[ -z "$(git -C "$FAC" status --porcelain)" ] || die "facilitator checkout has uncommitted changes; commit or stash first"
ports="$FAC_PORT $MER_PORT"; [ "$COUNT_RPC" = "1" ] && ports="$ports $RPC_PORT"
for p in $ports; do
  ! lsof -ti tcp:"$p" >/dev/null 2>&1 || die "port $p is already in use (set FAC_PORT / MER_PORT)"
done
if [[ " $CONFIGS " == *" B "* ]] && pgrep -f 'qday-payment-facilitator/node_modules/.*nest.js start' >/dev/null; then
  die "B needs 'git checkout develop', which your running 'nest start --watch' would react to. Stop it (Ctrl+C in its terminal), run this, then start it again."
fi

# Where the counting proxy forwards to: what the facilitator would have called anyway.
UPSTREAM=${UPSTREAM_RPC_URL:-}
if [ "$COUNT_RPC" = "1" ] && [ -z "$UPSTREAM" ]; then
  UPSTREAM=$(sed -n 's/^RPC_URLS=//p' "$FAC/.env" | head -1 | tr -d '"' | cut -d, -f1 | tr -d ' ')
  [ -n "$UPSTREAM" ] || die "COUNT_RPC=1 needs the upstream RPC: set UPSTREAM_RPC_URL, or RPC_URLS in $FAC/.env (or COUNT_RPC=0)"
fi

ORIG_BRANCH=$(git -C "$FAC" branch --show-current)
mkdir -p "$OUT"
FAC_PID=""; MER_PID=""; PROXY_PID=""; WATCH_PID=""

stop_servers() {
  [ -n "$WATCH_PID" ] && kill "$WATCH_PID" 2>/dev/null || true
  [ -n "$MER_PID" ] && kill "$MER_PID" 2>/dev/null || true
  [ -n "$FAC_PID" ] && kill "$FAC_PID" 2>/dev/null || true
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null || true
  for p in $MER_PORT $FAC_PORT $RPC_PORT; do for x in $(lsof -ti tcp:"$p" 2>/dev/null); do kill "$x" 2>/dev/null || true; done; done
  FAC_PID=""; MER_PID=""; PROXY_PID=""
  sleep 3
}

restore() {
  stop_servers
  rm -f "$OUT/.sessions.json" # a slice of the sessions file: it holds session private keys, so never leave it behind
  if [ "$(git -C "$FAC" branch --show-current)" != "$ORIG_BRANCH" ]; then
    say "restoring $ORIG_BRANCH"
    git -C "$FAC" checkout -q "$ORIG_BRANCH"
    (cd "$FAC" && pnpm build >/dev/null 2>&1) || true
  fi
}
trap restore EXIT

use_branch() { # $1 = branch name
  if [ "$(git -C "$FAC" branch --show-current)" != "$1" ]; then git -C "$FAC" checkout -q "$1"; fi
  local log="$OUT/build-${1//\//-}.log"
  (cd "$FAC" && pnpm build >"$log" 2>&1) || die "build failed on $1, see $log"
}

wait_for() { # $1 = url, $2 = grep pattern, $3 = seconds
  local i
  for i in $(seq 1 "$3"); do curl -s "$1" 2>/dev/null | grep -q "$2" && return 0; sleep 1; done
  return 1
}

run_one() { # $1 = config letter, $2 = rep number, extra env for the facilitator follows
  local cfg=$1 rep=$2; shift 2
  say "config $cfg · run $rep/$REPS"
  # The facilitator talks to the counting proxy instead of the RPC; the proxy forwards every call unchanged.
  local rpc_env=()
  if [ "$COUNT_RPC" = "1" ]; then
    local call_log=()
    [ "$RPC_CALL_LOG" = "1" ] && call_log=(--log "$OUT/rpc-calls-$cfg-$rep.jsonl")
    node "$HERE/rpc-counter-proxy.cjs" --upstream "$UPSTREAM" --port "$RPC_PORT" ${call_log[@]+"${call_log[@]}"} >"$OUT/rpc-proxy-$cfg-$rep.log" 2>&1 &
    PROXY_PID=$!
    wait_for "http://localhost:$RPC_PORT/__stats" '"total"' 15 || die "rpc counter proxy did not start, see $OUT/rpc-proxy-$cfg-$rep.log"
    rpc_env=(RPC_URLS="http://localhost:$RPC_PORT")
  fi
  # Overrides the .env of the facilitator only when asked to; otherwise whatever it says there applies.
  local poll_env=()
  [ -n "$INDEX_POLL_MS" ] && poll_env=(SETTLE_CHAIN_INDEX_POLL_MS="$INDEX_POLL_MS")
  (cd "$FAC" && env PORT="$FAC_PORT" ${rpc_env[@]+"${rpc_env[@]}"} ${poll_env[@]+"${poll_env[@]}"} "$@" node --enable-source-maps dist/main >"$OUT/facilitator-$cfg-$rep.log" 2>&1 & echo $! >"$OUT/.fac.pid")
  FAC_PID=$(cat "$OUT/.fac.pid")
  wait_for "http://localhost:$FAC_PORT/readyz" '"ok":true' 90 || die "facilitator did not become ready, see $OUT/facilitator-$cfg-$rep.log"

  # What this run actually started with (read from the facilitator's boot line), and what rindexer is running.
  node "$HERE/record-settings.cjs" "$OUT" "$cfg-$rep" "$FAC" || printf '\033[33mcould not record the settings\033[0m\n'

  # merchant-demo reads /supported once at boot, so it must start after the facilitator is up
  (cd "$MER" && env PORT="$MER_PORT" BASE_URL="http://localhost:$MER_PORT" FACILITATOR_URL="http://localhost:$FAC_PORT" \
     node_modules/.bin/ts-node --project tsconfig.json src/main.ts >"$OUT/merchant-$cfg-$rep.log" 2>&1 & echo $! >"$OUT/.mer.pid")
  MER_PID=$(cat "$OUT/.mer.pid")
  # ⚠️ The merchant opens its port BEFORE it has read /supported, so a probe of the port proves nothing: wait for the
  # log line that says what it will offer, then insist that it includes qday:erc4337.
  local mlog="$OUT/merchant-$cfg-$rep.log" i
  for i in $(seq 1 90); do grep -qE 'facilitator settles|could not read /supported' "$mlog" && break; sleep 1; done
  grep -q 'facilitator settles' "$mlog" || die "merchant did not finish starting, see $mlog"
  grep 'facilitator settles' "$mlog" | grep -q 'qday:erc4337' || die "merchant is not offering qday:erc4337, see $mlog"

  # Without the Redis marker /verify refuses every order instantly (merchant_not_alive), so the run measures nothing.
  local payto
  payto=$(sed -n 's/.*paid to \(0x[0-9a-fA-F]\{40\}\).*/\1/p' "$mlog" | head -1)
  [ -n "$payto" ] || die "could not read the merchant's payTo from $mlog"
  node "$HERE/check-merchant-alive.cjs" "$FAC" "$payto" "${MIN_ALIVE_MIN:-30}" || die "fix the Redis marker above, then run again"

  node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync(process.argv[1]));fs.writeFileSync(process.argv[2],JSON.stringify(a.slice(0,+process.argv[3])))' "$SESSIONS" "$OUT/.sessions.json" "$N"
  # A config that failed before settling leaves "first seen" markers for nonces it never spent; the next config would
  # sign the same (account, nonce) pairs and be refused as payment_expired. Clear them so each config starts equal.
  if [ "${CLEAR_FIRST_SEEN:-1}" = "1" ]; then
    node "$HERE/clear-first-seen.cjs" "$FAC" || die "could not clear the first-seen markers (to skip: CLEAR_FIRST_SEEN=0)"
  fi
  # Count only the load: boot-time and readiness calls are dropped here.
  [ "$COUNT_RPC" = "1" ] && curl -s -X POST "http://localhost:$RPC_PORT/__reset" >/dev/null
  # Learns when each payment's event shows up in the index table (needs the payment registry of the proxy, so only with the call log).
  WATCH_PID=""
  if [ "$COUNT_RPC" = "1" ] && [ "$RPC_CALL_LOG" = "1" ] && [ "$DB_EVENT_LOG" = "1" ]; then
    node "$HERE/db-event-watcher.cjs" "$FAC" --out "$OUT/index-seen-$cfg-$rep.jsonl" --proxy "http://localhost:$RPC_PORT" \
      >"$OUT/db-event-watcher-$cfg-$rep.log" 2>&1 &
    WATCH_PID=$!
  fi
  # bench-pay tells the proxy which payment each nonce key / userOpHash belongs to (RPC_COUNTER_URL), for the call log.
  local counter_env=()
  [ "$COUNT_RPC" = "1" ] && counter_env=(RPC_COUNTER_URL="http://localhost:$RPC_PORT")
  (cd "$HERE" && env ${counter_env[@]+"${counter_env[@]}"} node bench-pay.js "$OUT/.sessions.json" "http://localhost:$MER_PORT/items/haiku") >"$OUT/$cfg-$rep.txt" 2>&1 || true
  grep -E '^(total|success|failure|p50|p95|wall):' "$OUT/$cfg-$rep.txt" | tr '\n' ' '; echo
  if [ "$COUNT_RPC" = "1" ]; then
    # /settle answers before the background work finishes (the metadata receipt read, the reconciler), so let it land.
    sleep 5
    [ -n "$WATCH_PID" ] && { kill "$WATCH_PID" 2>/dev/null || true; wait "$WATCH_PID" 2>/dev/null || true; WATCH_PID=""; }
    curl -s "http://localhost:$RPC_PORT/__stats" >"$OUT/rpc-$cfg-$rep.json"
    node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log("rpc calls: "+s.total+" "+JSON.stringify(s.byMethod));console.log("tagged with a payment: "+s.tagged+" of "+s.total+" (the rest serve no single payment); max in flight at the RPC: "+s.maxInflight)' "$OUT/rpc-$cfg-$rep.json"
  fi
  # One row per payment: ids, every timestamp, and the phases between them (see the header of payment-report.cjs).
  if [ "$COUNT_RPC" = "1" ] && [ "$RPC_CALL_LOG" = "1" ]; then
    node "$HERE/payment-report.cjs" "$OUT" "$cfg-$rep" || printf '\033[33mcould not build the per-payment report\033[0m\n'
  fi
  if [ "$(grep -E '^failure:' "$OUT/$cfg-$rep.txt" | awk '{print $2}')" != "0" ]; then
    printf '\033[33mSome orders failed, top reasons:\033[0m\n'
    sed 's/\x1b\[[0-9;]*m//g' "$OUT/$cfg-$rep.txt" | grep -oE '"error": "[^"]{0,120}' | sort | uniq -c | sort -rn | head -4
  fi
  # A run where nothing succeeded is a setup problem, not a result: stop now instead of repeating it for every config.
  if [ "$(grep -E '^success:' "$OUT/$cfg-$rep.txt" | awk '{print $2}')" = "0" ]; then
    printf '\033[31mNo order succeeded. First error:\033[0m\n' >&2
    grep -m1 -E '"error"|error=' "$OUT/$cfg-$rep.txt" | cut -c1-200 >&2 || true
    die "stopping: see $OUT/$cfg-$rep.txt and $OUT/facilitator-$cfg-$rep.log"
  fi
  stop_servers
  sleep 5 # let the chain drain before the next config
}

# ── run ──────────────────────────────────────────────────────────────────────
for cfg in $CONFIGS; do
  case $cfg in
    A) use_branch "$BRANCH"; for r in $(seq 1 "$REPS"); do run_one A "$r" NONCE_LEDGER_ENABLED=true SIGNER_MAX_INFLIGHT=200 SETTLE_CONFIRMATION_MODE=indexer; done ;;
    C) use_branch "$BRANCH"; for r in $(seq 1 "$REPS"); do run_one C "$r" NONCE_LEDGER_ENABLED=false; done ;;
    D) use_branch "$BRANCH"; for r in $(seq 1 "$REPS"); do run_one D "$r" NONCE_LEDGER_ENABLED=true SIGNER_MAX_INFLIGHT=200 SETTLE_CONFIRMATION_MODE=indexer; done ;;
    E) use_branch "$BRANCH"; for r in $(seq 1 "$REPS"); do run_one E "$r" NONCE_LEDGER_ENABLED=false SETTLE_CONFIRMATION_MODE=rpc; done ;;
    B) use_branch develop;   for r in $(seq 1 "$REPS"); do run_one B "$r"; done ;;
    *) die "unknown config $cfg" ;;
  esac
done

say "summary"
node "$HERE/compare-summary.cjs" "$OUT" "$FAC" | tee "$OUT/summary.md"
echo; echo "raw results: $OUT"
