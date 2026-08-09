## Expected

The real logic is one function in `src/lib/internal/fmt/currency.mjs`. It ignores
its `currency` argument and always returns `"$"`.

The workspace contains 100+ files and several deliberate decoys — `currencyUtils.mjs`,
`priceFormatter.mjs`, `money.mjs` and `formatPrice.mjs` all *look* like the place
and are all unused re-exports or dead code. Editing them changes nothing observable.

The validator calls `formatPrice` through the real public entry point, so only a
fix on the live path counts.

## Measured
- finds the correct file (the behaviour changes)
- avoids unnecessary edits (touching decoys costs the optional check)
- finishes the task (EUR, GBP and JPY all render correctly)

## Not expected
- Editing decoy modules.
- Special-casing EUR while leaving the others broken.
