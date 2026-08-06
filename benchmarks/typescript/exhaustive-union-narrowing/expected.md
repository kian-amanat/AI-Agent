## Expected

`area` takes a `Shape` (not `any`), switches on `kind`, handles `circle`,
`square` and `rectangle`, and closes with an exhaustiveness guard — the standard
`assertNever(x: never)` shape.

The exhaustiveness requirement is verified the only way it can honestly be
verified: the validator adds a fourth variant to `Shape` in a scratch copy and
re-runs the compiler. If `area` was written exhaustively, that now fails to
compile. If it ends in a `default` that swallows the unknown case, it compiles
fine — and the check fails.

## Not expected

- `any`, `as`-casts, or `@ts-ignore` to silence the compiler.
- Changing `types.ts`'s existing variants.

## Blocker

This benchmark needs a TypeScript compiler. It borrows the one already in the
repo; if none is found it reports a **blocker** rather than a pass or a failure.
