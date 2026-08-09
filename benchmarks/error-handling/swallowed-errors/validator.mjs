/** Three paths, driven for real through a stubbed transport. */
import { check, guard, behaviourCheck, importFromWorkspace } from "../../_lib/checks.mjs";

export default async function validate({ workspace }) {
  const checks = [];
  let mod = null;
  checks.push(await behaviourCheck("client.mjs still loads", async () => {
    mod = await importFromWorkspace(workspace, "client.mjs");
    if (typeof mod.fetchUser !== "function") return "fetchUser is no longer exported";
  }, { guard: true }));
  if (!mod?.fetchUser) return checks;

  checks.push(await behaviourCheck("the success path is unchanged", async () => {
    mod.setTransport(async () => ({ status: 200, body: { id: "u1", name: "Ada" } }));
    const u = await mod.fetchUser("u1");
    if (u?.name !== "Ada") return `expected the user object, got ${JSON.stringify(u)}`;
  }, { guard: true }));

  checks.push(await behaviourCheck("a 404 still means 'no such user'", async () => {
    mod.setTransport(async () => ({ status: 404, body: null }));
    const u = await mod.fetchUser("nope");
    if (u !== null && u !== undefined) return `expected null/undefined for 404, got ${JSON.stringify(u)}`;
  }, { guard: true }));

  checks.push(await behaviourCheck("a transport failure is distinguishable from 'not found'", async () => {
    mod.setTransport(async () => { throw new Error("ECONNREFUSED"); });
    let threw = false;
    let value;
    try { value = await mod.fetchUser("u1"); } catch { threw = true; }
    if (threw) return;                       // throwing is a valid answer
    if (value === null || value === undefined) {
      return "a network failure still returns null — a caller cannot tell it apart from a missing user";
    }
  }));

  // Critical, not advisory: the prompt's whole complaint is that callers cannot
  // tell one failure from another. An error that surfaces but hides its cause
  // has moved the problem, not solved it.
  checks.push(await behaviourCheck("the failure carries the underlying cause", async () => {
    mod.setTransport(async () => { throw new Error("ECONNREFUSED"); });
    try {
      const v = await mod.fetchUser("u1");
      if (v && (v.error || v.ok === false)) return;   // a result object is fine
      return "no error information reached the caller";
    } catch (e) {
      if (!/ECONNREFUSED/.test(String(e?.message ?? e)) && !e?.cause) {
        return "the thrown error hides what actually went wrong";
      }
    }
  }));

  return checks;
}
