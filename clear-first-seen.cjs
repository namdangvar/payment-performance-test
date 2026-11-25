// Deletes the facilitator's per-payment "first seen" markers (`qday-aa:first-seen:*`) from Redis.
//   node clear-first-seen.cjs <facilitator-dir>
//
// Why: the facilitator refuses a payment it first saw more than 90 seconds ago (`invalid_qday_erc4337_payment_expired`).
// A benchmark config that fails before settling leaves the markers behind but does not spend the nonces, so the next
// config signs the very same (account, nonce) pairs and is refused for that reason, not because of its own code.
// Only this one key prefix is touched.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const [, , facDir] = process.argv;

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
    let cursor = '0';
    let deleted = 0;
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'qday-aa:first-seen:*', 'COUNT', 500);
      cursor = next;
      if (keys.length) deleted += await redis.unlink(...keys);
    } while (cursor !== '0');
    console.log(`cleared ${deleted} first-seen marker(s)`);
  } catch (e) {
    console.error(`could not clear first-seen markers: ${e.message}`);
    process.exit(2);
  } finally {
    redis.disconnect();
  }
})();
