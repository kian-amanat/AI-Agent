## Expected

One new module exports `slugify`. Both `posts.mjs` and `tags.mjs` import it and
no longer define their own copy. `index.mjs` keeps working untouched.

The validator imports the real modules and re-runs the original behaviour across a
table of inputs, so a refactor that changes edge-case behaviour (trimming,
repeated separators, leading dashes) fails even though the duplication is gone.

## Not expected

- Deleting one copy and having that module import from the *other* feature module
  — that is not extraction, it just makes `tags` depend on `posts`.
- Changing what `slugify` returns for any input.
