`expensiveLookup(key)` in `lookup.mjs` is called over and over with the same handful of keys, and each call re-scans the whole dataset.

Make repeated lookups cheap without changing what the function returns for any input.
