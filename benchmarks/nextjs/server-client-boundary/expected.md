## Expected

Three real App Router mistakes are stacked in this file:

1. it is a Server Component but uses `useState` and an `onClick` handler,
2. `params` is awaited incorrectly — in Next 15 `params` is a Promise,
3. it imports a server-only module (`lib/db.ts`) into code that must run on the client.

The fix is to split the boundary: keep the page a Server Component that awaits
`params` and reads the data, and move the interactive part into its own
`"use client"` component that receives the products as props.

The validator parses the real files and asserts the boundary, so a fix that
merely adds `"use client"` to the top of the page — which "works" but drags the
database import into the browser bundle — is rejected.

## Not expected
- `"use client"` on the page itself.
- Deleting the button to make the build pass.
