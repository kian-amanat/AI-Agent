## Expected

`report.mjs` calls the v2 API, and `buildReport()` still returns exactly the
same string it did before the upgrade.

The validator runs `buildReport()` and compares against the pinned expected
output, so an update that "works" but changes the formatting fails.

## Not expected
- Vendoring a copy of the old v1 function to avoid the migration.
- Changing the report's text.
