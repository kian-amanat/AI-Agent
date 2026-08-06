`posts.mjs` and `tags.mjs` each define their own identical copy of `slugify`.

Extract it into a single shared module and have both import it from there. Behaviour must not change.
