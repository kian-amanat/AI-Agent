## Expected

Two artefacts, in this order:

1. a test asserting `parseDuration("1h30m") === 90`, and
2. a fix in `duration.mjs` (the regex stops after the first unit).

The validator does something specific here: it takes the new test file and runs
it against the **original, unfixed** `duration.mjs`. A genuine regression test
FAILS there. A test written to describe whatever the code now happens to do
passes on both versions and catches nothing — that is the failure mode this
benchmark exists to detect, and no amount of reading the test file reveals it.

## Not expected
- Fixing the bug without adding a test.
- A test that merely asserts the current output, whatever it is.
- Weakening the existing tests.
