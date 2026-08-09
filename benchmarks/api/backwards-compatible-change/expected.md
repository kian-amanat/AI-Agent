## Expected

`search("a")` behaves exactly as before — same results, same order, same
default count. `search("a", { limit: 2 })` returns two, and `{ offset: 2 }`
skips two.

The validator runs the **existing caller** in `legacy.mjs` untouched, plus the
new paginated forms. Adding a required second parameter, changing the return
shape, or reordering results all break the old caller and fail — which is the
entire point of a backwards-compatible change.

## Not expected
- Making `options` required.
- Returning a `{ items, total }` envelope instead of an array.
