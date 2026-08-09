## Expected

`node cli.mjs Ada` prints `hello, Ada` and exits 0.
`node cli.mjs` (no argument) prints a usage message to stderr and exits non-zero.

The validator spawns the CLI as a real process and reads the real exit codes, so
a fix that only prints "error" without changing the exit status fails.

## Not expected
- Changing the success output.
- Exiting non-zero on success.
