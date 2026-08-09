Users report that `parseDuration("1h30m")` returns 60 instead of 90 minutes.

Before fixing it, add a regression test that reproduces the bug. Then fix the bug so the test passes. Keep the existing tests passing.
