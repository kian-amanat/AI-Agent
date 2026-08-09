`readDoc(name)` in `docs.mjs` serves files from the `docs/` directory, but a caller can escape it with `../`. Fix the traversal without breaking legitimate reads.
