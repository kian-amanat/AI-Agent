## Expected

A question, not a task. The agent should read `rateLimiter.mjs` and explain it:
a token bucket, refilled at `TOKENS_PER_SECOND`, capped at `capacity`. When a
client is out of tokens, `consume()` returns `{ allowed: false, retryAfterMs }`
rather than throwing — `retryAfterMs` being the wait until one token is back.

**Nothing in the workspace may change.** Rewriting, "improving", or adding tests
to a file the user only asked about is the failure mode this catches.

The answer must be grounded in the actual file — the specific identifiers are
checked, so a plausible-sounding generic description of rate limiting fails.
