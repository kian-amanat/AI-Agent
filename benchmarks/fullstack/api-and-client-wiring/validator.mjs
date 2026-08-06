/**
 * Each layer is exercised for real, and then the whole stack is driven end to
 * end with the server wired in as the client's transport. That last check is
 * the one a "wrote three files that never meet" run fails.
 */
import { check, behaviourCheck, importFromWorkspace } from "../../_lib/checks.mjs";

export default async function validate({ workspace, run }) {
  const checks = [];

  let api = null, client = null, app = null;
  checks.push(await behaviourCheck("all three modules still load", async () => {
    api = await importFromWorkspace(workspace, "server/api.mjs");
    client = await importFromWorkspace(workspace, "client/apiClient.mjs");
    app = await importFromWorkspace(workspace, "client/App.mjs");
    if (typeof api.handle !== "function") return "server/api.mjs no longer exports handle()";
  }, { guard: true }));
  if (!api?.handle) return checks;

  checks.push(await behaviourCheck("GET /api/users/u1 returns the user", () => {
    const res = api.handle("GET", "/api/users/u1");
    if (res?.status !== 200) return `expected 200, got ${JSON.stringify(res)}`;
    if (res.body?.name !== "Ada Lovelace") return `expected Ada Lovelace, got ${JSON.stringify(res.body)}`;
  }));

  // A second id, so a hardcoded /api/users/u1 cannot pass.
  checks.push(await behaviourCheck("the route is parameterised, not hardcoded", () => {
    const res = api.handle("GET", "/api/users/u2");
    if (res?.status !== 200 || res.body?.name !== "Grace Hopper") {
      return `GET /api/users/u2 gave ${JSON.stringify(res)} — the id is not being read from the path`;
    }
  }));

  checks.push(await behaviourCheck("an unknown user 404s", () => {
    const res = api.handle("GET", "/api/users/nope");
    if (res?.status !== 404) return `expected 404, got ${JSON.stringify(res)}`;
    if (res.body?.error !== "not found") return `expected { error: "not found" }, got ${JSON.stringify(res.body)}`;
  }));

  checks.push(await behaviourCheck("the existing user-list endpoint still works", () => {
    const res = api.handle("GET", "/api/users");
    if (res?.status !== 200 || !Array.isArray(res.body) || res.body.length !== 2) {
      return `GET /api/users regressed: ${JSON.stringify(res)}`;
    }
  }, { guard: true }));

  checks.push(check("the client exports getUser(id)", typeof client?.getUser === "function",
    `client/apiClient.mjs exports: ${Object.keys(client ?? {}).join(", ")}`));

  // The whole point: wire the real server in as the client's transport and see
  // whether a call started at the view layer arrives at the endpoint.
  checks.push(await behaviourCheck("getUser() reaches the real endpoint through request()", async () => {
    if (typeof client?.getUser !== "function") return "no getUser to call";
    const seen = [];
    client.setTransport(async (method, url) => {
      seen.push(`${method} ${url}`);
      return api.handle(method, url);
    });
    const user = await client.getUser("u2");
    if (!seen.length) return "getUser() never went through request()/the transport — it bypassed the shared client";
    if (user?.name !== "Grace Hopper") return `getUser("u2") resolved to ${JSON.stringify(user)}`;
  }));

  checks.push(await behaviourCheck("renderUser(id) returns the user's name end to end", async () => {
    if (typeof app?.renderUser !== "function") return "client/App.mjs no longer exports renderUser";
    client.setTransport(async (method, url) => api.handle(method, url));
    const out = await app.renderUser("u1");
    if (typeof out !== "string" || !out.includes("Ada Lovelace")) {
      return `renderUser("u1") returned ${JSON.stringify(out)} — the view is not wired to the client`;
    }
  }));

  checks.push(check(
    "all three layers were actually touched",
    ["server/api.mjs", "client/apiClient.mjs", "client/App.mjs"].every((f) => run.workspaceChanges.changed.includes(f)),
    `changed: ${run.workspaceChanges.changed.join(", ") || "(nothing)"}`,
    { critical: false }
  ));

  return checks;
}
