Add the ability to fetch a single user, end to end:

1. In `server/api.mjs`, add a `GET /api/users/:id` endpoint that returns the matching user from the in-memory `USERS` map, or a 404 with `{ error: "not found" }` when there is no such user.
2. In `client/apiClient.mjs`, add a `getUser(id)` function that calls that endpoint the same way `getUsers()` does.
3. In `client/App.mjs`, make `renderUser(id)` use `getUser` and return the user's name.
