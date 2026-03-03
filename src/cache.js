export function createCache(defaultTtlMs = 1000 * 60 * 60 * 6) {
  const cache = new Map();

  function get(key) {
    const entry = cache.get(key);
    if (!entry) {
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      cache.delete(key);
      return null;
    }

    return entry.value;
  }

  function set(key, value, ttlMs = defaultTtlMs) {
    cache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  return { get, set };
}
