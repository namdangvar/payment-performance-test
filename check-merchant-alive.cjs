// Fails fast when facilitator /verify would answer `merchant_not_alive`.
//   node check-merchant-alive.cjs <facilitator-dir> <payTo> [min-remaining-minutes]
// The marker `merchant:alive:<payTo>` is written by merchant-server in production; locally it is created by hand
// and expires, which fails EVERY order instantly (before any nonce or chain work) and looks like a code bug.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const [, , facDir, payTo, minArg] = process.argv;
const minSeconds = Number(minArg ?? 30) * 60;

function redisUrl() {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  const line = fs.readFileSync(path.join(facDir, '.env'), 'utf8').split('\n').find((l) => l.startsWith('REDIS_URL='));
  return line ? line.slice('REDIS_URL='.length).trim() : 'redis://localhost:6379';
}

(async () => {
  const Redis = require(path.join(facDir, 'node_modules/ioredis'));
  const redis = new Redis(redisUrl(), { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    const key = `merchant:alive:${payTo.toLowerCase()}`;
    const ttl = await redis.ttl(key); // -2 = missing, -1 = no expiry
    if (ttl === -2) {
      console.error(`Redis key ${key} is missing, so every payment is refused with merchant_not_alive.`);
      console.error(`Create it:  docker exec redis-phkd redis-cli SET ${key} 1 EX 21600`);
      process.exit(1);
    }
    if (ttl !== -1 && ttl < minSeconds) {
      console.error(`Redis key ${key} expires in ${Math.round(ttl / 60)} min (need ${Math.round(minSeconds / 60)}).`);
      console.error(`Renew it:  docker exec redis-phkd redis-cli SET ${key} 1 EX 21600`);
      process.exit(1);
    }
    console.log(`merchant alive marker ok (${ttl === -1 ? 'no expiry' : `${Math.round(ttl / 60)} min left`})`);
  } catch (e) {
    console.error(`merchant alive check failed: ${e.message}`);
    process.exit(2);
  } finally {
    redis.disconnect();
  }
})();
