## Expected

A test file the project's runner (`node --test`) picks up, with real assertions for
each of the three named cases. The validator runs the suite itself and requires a
clean exit.

It also counts test cases and assertions: a single smoke test that imports the
module and asserts nothing satisfies "npm test passes" while covering nothing,
which is the outcome this benchmark exists to reject.

`slugify.mjs` is already correct and should not need to change.

## Not expected

- Tests that assert against `slugify`'s implementation rather than its output.
- Weakening the suite (`test.skip`, `todo`) to get a clean run.
