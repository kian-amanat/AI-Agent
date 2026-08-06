## Expected

`server.mjs` gains a `"GET /api/health"` entry in the existing `routes` object,
returning `{ status: 200, body: { status: "ok" } }`.

The validator imports the module and calls `handle("GET", "/api/health")` for real,
so a route that is described in a comment, added to the wrong object, or wired into
a second parallel router will not pass.

The existing `/api/ping` route and the 404 fallback must keep working.

## Not expected

- Replacing the routing mechanism.
- Starting a server on a port (the module only listens when `START_SERVER` is set).
