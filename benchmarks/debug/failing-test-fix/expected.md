## Expected

`range(start, end)` is meant to be inclusive of `start` and exclusive of `end`,
but its loop condition uses `<=`, so every result carries one extra element.
`sumRange` inherits the bug.

The fix is one character in `src/range.mjs`. Afterwards `node --test` exits 0.

The validator runs the suite itself, so "I fixed it" without a passing run does
not count — and it re-runs the ORIGINAL tests, so deleting or weakening an
assertion to get green is caught.

## Not expected

- Editing `test/range.test.mjs`.
- Rewriting `range` from scratch, or changing its signature.
