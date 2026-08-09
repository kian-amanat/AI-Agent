## Expected

`migrate(db)` can be called any number of times. The first call creates the
table and adds the column; subsequent calls are no-ops. Rows inserted between
calls survive.

The validator runs the migration twice against the in-memory store, with a row
inserted in between, and asserts both that it does not throw and that the data
is still there.

## Not expected
- Dropping and recreating the table (that loses rows).
- Swallowing every error with a bare try/catch — the validator inserts a real
  row and checks it survived.
