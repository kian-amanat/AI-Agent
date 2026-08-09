`getUser(id)` in `cache.mjs` is supposed to cache results, but when several callers ask for the same id at the same time it fetches it once per caller.

Fix it so concurrent callers for the same id share a single fetch. Different ids must still fetch independently, and a failed fetch must not be cached.
