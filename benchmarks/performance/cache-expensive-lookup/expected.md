## Expected

Memoise the result per key. After the change, calling `expensiveLookup("k500")`
one hundred times performs **one** scan, not one hundred.

The dataset counts its own scans (`getScanCount()`), so this is measured, not
timed — the check is deterministic and cannot flake on a fast or busy machine.

Misses must be cached too: a key that is not present is just as expensive to
look up, and re-scanning for it every time is the same bug.

## Not expected

- Changing the return values. `expensiveLookup` still returns the record, or
  `null` for a key that does not exist.
- Precomputing the whole index at module load in a way that changes `getScanCount()`
  semantics is fine — what matters is that N repeated calls do not cost N scans.
