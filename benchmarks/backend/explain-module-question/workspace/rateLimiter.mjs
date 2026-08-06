const TOKENS_PER_SECOND = 5;

/**
 * A per-client token bucket. Each client gets `capacity` tokens, refilled
 * continuously at TOKENS_PER_SECOND up to the cap.
 */
export function createRateLimiter({ capacity = 20 } = {}) {
  const buckets = new Map();

  function refill(bucket, now) {
    const elapsedSeconds = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * TOKENS_PER_SECOND);
    bucket.lastRefill = now;
  }

  return {
    consume(clientId, now = Date.now()) {
      let bucket = buckets.get(clientId);
      if (!bucket) {
        bucket = { tokens: capacity, lastRefill: now };
        buckets.set(clientId, bucket);
      }
      refill(bucket, now);

      if (bucket.tokens < 1) {
        // Not an exception — the caller decides what to do with a refusal.
        const retryAfterMs = Math.ceil(((1 - bucket.tokens) / TOKENS_PER_SECOND) * 1000);
        return { allowed: false, retryAfterMs, remaining: 0 };
      }

      bucket.tokens -= 1;
      return { allowed: true, retryAfterMs: 0, remaining: Math.floor(bucket.tokens) };
    },
  };
}
