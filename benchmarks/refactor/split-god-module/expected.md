## Expected

The four concerns end up in separate modules, `store.mjs` no longer holds all of
them, and `index.mjs` re-exports exactly the same names as before.

The validator drives the public API through a table of 20 cases spanning every
concern — including the awkward ones (empty cart, zero quantity, a discount that
would go negative, a name with no surname, a leap day). A split that changes any
observable answer fails, however clean the file layout looks.

This is the *large* refactor: wide but shallow, several files, and the only thing
that must not move is behaviour.

## Not expected
- Changing `index.mjs`'s export list.
- Leaving everything in `store.mjs` and merely re-exporting from new files.
