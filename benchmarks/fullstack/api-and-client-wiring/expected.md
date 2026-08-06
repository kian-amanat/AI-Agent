## Expected

Three files change and they must agree with each other:

- `server/api.mjs` — `handle("GET", "/api/users/u1")` returns 200 with the real user
  record; an unknown id returns 404 with `{ error: "not found" }`. The path is
  parameterised, so it cannot be satisfied by hardcoding `/api/users/u1`.
- `client/apiClient.mjs` — exports `getUser(id)`, routed through the same
  `request()` helper `getUsers()` uses.
- `client/App.mjs` — `renderUser(id)` calls `getUser` and resolves to the name.

The validator drives all three for real, with a stubbed transport, so a layer that
was written but never connected is caught.

## Not expected

- Changing the transport or the shape of `USERS`.
- A client function that bypasses `request()` and builds its own fetch.
