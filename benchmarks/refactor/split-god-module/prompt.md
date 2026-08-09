`store.mjs` has grown into a grab-bag of unrelated concerns: cart maths, user formatting, date helpers and validation all live in one file.

Split it into focused modules. `index.mjs` is the public API and its exports must not change.
