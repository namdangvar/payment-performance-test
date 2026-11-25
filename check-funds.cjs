// Fails fast when the sessions' wallet cannot pay for the whole run.
//   node check-funds.cjs <sessions-file> <N> <runs> [merchant-env-file]
// Every order spends the item price (default 0.01 tUSD8 = 10000 atomic) from the wallet behind the session, and all
// sessions of one qpass share ONE wallet. A run needs N × runs × price; when the wallet runs dry the orders fail with
// `insufficient_funds` / reverted handleOps (each revert still burns the facilitator's gas), which looks like a bug.
'use strict';
const fs = require('node:fs');
const { createPublicClient, http, parseAbi, formatUnits } = require('viem');

const [, , file, nArg, runsArg, merchantEnv] = process.argv;
const n = Number(nArg);
const runs = Number(runsArg);
const price = BigInt(process.env.ORDER_PRICE_ATOMIC ?? '10000');

function envFrom(f) {
  const vars = {};
  if (f && fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('#') && t.includes('=')) vars[t.slice(0, t.indexOf('=')).trim()] = t.slice(t.indexOf('=') + 1).trim();
    }
  }
  return vars;
}

(async () => {
  const m = envFrom(merchantEnv);
  const asset = process.env.ASSET_ADDRESS ?? m.ASSET_ADDRESS ?? '0x456569838f1d43009A91ebA4263147Afd7233483';
  const decimals = Number(process.env.ASSET_DECIMALS ?? m.ASSET_DECIMALS ?? 6);
  const client = createPublicClient({ transport: http(process.env.RPC_URL ?? 'https://rpc-test.qday.info') });
  const abi = parseAbi(['function balanceOf(address) view returns (uint256)']);

  const sessions = JSON.parse(fs.readFileSync(file, 'utf8')).slice(0, n);
  const perWallet = new Map();
  for (const s of sessions) perWallet.set(s.walletAddress, (perWallet.get(s.walletAddress) ?? 0) + 1);

  let short = false;
  for (const [wallet, count] of perWallet) {
    const need = BigInt(count) * BigInt(runs) * price;
    const have = await client.readContract({ address: asset, abi, functionName: 'balanceOf', args: [wallet] });
    const f = (v) => formatUnits(v, decimals);
    if (have < need) {
      short = true;
      console.error(`wallet ${wallet}: has ${f(have)} tUSD8, this run spends up to ${f(need)} (${count} orders × ${runs} runs × ${f(price)}). Missing ${f(need - have)}.`);
    } else {
      console.log(`funds ok: wallet ${wallet} has ${f(have)} tUSD8, the run spends up to ${f(need)}`);
    }
  }
  if (short) {
    console.error('Top up the wallet above with tUSD8, or lower N / REPS / CONFIGS.');
    process.exit(1);
  }
})().catch((e) => {
  console.error(`funds check failed: ${e.message}`);
  process.exit(2);
});
