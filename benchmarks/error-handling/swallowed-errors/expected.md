## Expected

A successful fetch still returns the user object unchanged. A 404 still means
"no such user". A transport failure must NOT be reported as "no such user" — it
should throw, or return something a caller can distinguish.

The validator drives all three paths with a stubbed transport and asserts the
caller can tell them apart.

## Not expected
- Making the success path throw.
- Logging the error and still returning null.
