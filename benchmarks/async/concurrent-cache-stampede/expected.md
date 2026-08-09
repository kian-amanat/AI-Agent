## Expected

Ten simultaneous `getUser("u1")` calls perform **one** fetch and all resolve to
the same value. Two different ids still perform two fetches. If a fetch rejects,
the failure is not cached — the next call retries.

The fetcher counts its own invocations, so this is measured, not timed: the
check is an integer, and it cannot flake on a fast or slow machine.

## Not expected
- Caching the rejected promise (the next caller would inherit the failure
  forever).
- Serialising all ids behind one lock.
