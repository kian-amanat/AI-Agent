/**
 * Behavioural, not textual: the module is imported and the route is actually
 * called. "I added the endpoint" is not evidence; a 200 with the right body is.
 */
import { check, behaviourCheck, importFromWorkspace } from "../../_lib/checks.mjs";

export default async function validate({ workspace, helpers, run }) {
  const checks = [];
  const src = await helpers.read("server.mjs");
  checks.push(check("server.mjs still exists", src !== null, "server.mjs is gone", { guard: true }));
  if (src === null) return checks;

  let mod = null;
  checks.push(await behaviourCheck("server.mjs still loads", async () => {
    mod = await importFromWorkspace(workspace, "server.mjs");
    if (typeof mod.handle !== "function") return "the module no longer exports handle()";
  }, { guard: true }));
  if (!mod?.handle) return checks;

  checks.push(await behaviourCheck("GET /api/health responds 200", () => {
    const res = mod.handle("GET", "/api/health");
    if (!res) return "handle() returned nothing for GET /api/health";
    if (res.status !== 200) return `expected status 200, got ${res.status}`;
  }));

  checks.push(await behaviourCheck('GET /api/health body is {"status":"ok"}', () => {
    const { body } = mod.handle("GET", "/api/health") ?? {};
    if (!body || typeof body !== "object") return "no JSON body returned";
    if (body.status !== "ok") return `expected body.status === "ok", got ${JSON.stringify(body)}`;
  }));

  checks.push(await behaviourCheck("it was wired into the existing route table", () => {
    if (!mod.routes || typeof mod.routes !== "object") return "the routes export disappeared";
    if (!("GET /api/health" in mod.routes)) {
      return `the endpoint works but was not added to \`routes\` (keys: ${Object.keys(mod.routes).join(", ")}) — it was bolted on beside the table instead of into it`;
    }
  }, { guard: true }));

  checks.push(await behaviourCheck("the pre-existing /api/ping route still works", () => {
    const res = mod.handle("GET", "/api/ping");
    if (res?.status !== 200 || res?.body?.pong !== true) return `GET /api/ping regressed: ${JSON.stringify(res)}`;
  }, { guard: true }));

  checks.push(await behaviourCheck("unknown routes still 404", () => {
    const res = mod.handle("GET", "/api/nope");
    if (res?.status !== 404) return `expected 404 for an unknown route, got ${JSON.stringify(res)}`;
  }, { guard: true }));

  checks.push(check(
    "only server.mjs was changed",
    run.workspaceChanges.changed.every((f) => f === "server.mjs"),
    `also changed: ${run.workspaceChanges.changed.filter((f) => f !== "server.mjs").join(", ")}`,
    { critical: false }
  ));

  return checks;
}
