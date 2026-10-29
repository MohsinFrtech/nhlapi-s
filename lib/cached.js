const cache = require("./cache");

const inflight = new Map(); // key -> Promise, so concurrent misses share one upstream call

// Returns {data, status, ttlLeftMs}: status is HIT, MISS or STALE (old data served because the loader failed);
// ttlLeftMs is how long the entry stays fresh, used to set the CDN cache time.
// ttlMs is a number, or a function of the loaded data when the cache time depends on its content.
async function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit) return {data: hit, status: "HIT", ttlLeftMs: cache.remainingMs(key)};

  let pending = inflight.get(key);
  if (!pending) {
    pending = loader()
      .then((data) => {
        cache.set(key, data, typeof ttlMs === "function" ? ttlMs(data) : ttlMs);
        return data;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }

  try {
    const data = await pending;
    return {data, status: "MISS", ttlLeftMs: cache.remainingMs(key)};
  } catch (err) {
    const stale = cache.getStale(key);
    if (stale) return {data: stale, status: "STALE", ttlLeftMs: 0};
    throw err;
  }
}

module.exports = {cached};
