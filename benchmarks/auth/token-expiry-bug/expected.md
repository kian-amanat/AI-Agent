## Expected

The comparison uses `>` where it must reject anything at or past `expiresAt`.
A valid token still verifies; an expired one and one expiring exactly now must not.

The validator calls `verifyToken` with a frozen clock, so the boundary case is
deterministic rather than dependent on how fast the test machine is.

## Not expected
- Removing the expiry check.
- Changing the token format.
