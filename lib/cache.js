// In-memory TTL cache. Replace this file to use Redis or a database later;
// keep the same async get/set/getStale interface.
const store = new Map();
const CLEANUP_MS = 60 * 60 * 1000;
const MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;

function get(key) {
  const entry = store.get(key);
  if (!entry || entry.expiresAt <= Date.now()) return undefined;
  return entry.value;
}

// Expired-but-recent value, used when the upstream API is failing.
function getStale(key) {
  const entry = store.get(key);
  return entry ? entry.value : undefined;
}

// Milliseconds until the entry expires (0 if missing or already expired).
function remainingMs(key) {
  const entry = store.get(key);
  return entry ? Math.max(entry.expiresAt - Date.now(), 0) : 0;
}

function set(key, value, ttlMs) {
  store.set(key, {value, expiresAt: Date.now() + ttlMs});
}

const timer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt + MAX_STALE_MS <= now) store.delete(key);
  }
}, CLEANUP_MS);
timer.unref();

module.exports = {get, getStale, set, remainingMs};
