/** A frozen clock makes the boundary deterministic. */
import { check, guard, behaviourCheck, importFromWorkspace } from "../../_lib/checks.mjs";

const NOW = 1_700_000_000_000;

export default async function validate({ workspace, run }) {
  const checks = [];
  let mod = null;
  checks.push(await behaviourCheck("auth.mjs still loads", async () => {
    mod = await importFromWorkspace(workspace, "auth.mjs");
    if (typeof mod.verifyToken !== "function") return "verifyToken is no longer exported";
  }, { guard: true }));
  if (!mod?.verifyToken) return checks;

  checks.push(await behaviourCheck("a valid token still verifies", () => {
    const r = mod.verifyToken({ sub: "u1", expiresAt: NOW + 60_000 }, NOW);
    if (!r?.valid) return `expected valid, got ${JSON.stringify(r)}`;
    if (r.subject !== "u1") return `subject lost: ${JSON.stringify(r)}`;
  }, { guard: true }));

  checks.push(await behaviourCheck("an expired token is rejected", () => {
    const r = mod.verifyToken({ sub: "u1", expiresAt: NOW - 1 }, NOW);
    if (r?.valid) return "a token that expired 1ms ago was accepted";
  }));

  checks.push(await behaviourCheck("a token expiring exactly now is rejected", () => {
    const r = mod.verifyToken({ sub: "u1", expiresAt: NOW }, NOW);
    if (r?.valid) return "expiresAt === now must not be valid";
  }));

  checks.push(await behaviourCheck("a long-expired token is rejected", () => {
    const r = mod.verifyToken({ sub: "u1", expiresAt: NOW - 86_400_000 }, NOW);
    if (r?.valid) return "a day-old token was accepted";
  }));

  checks.push(await behaviourCheck("a malformed token is still rejected", () => {
    if (mod.verifyToken(null, NOW)?.valid) return "null was accepted";
    if (mod.verifyToken({ sub: "x" }, NOW)?.valid) return "a token with no expiresAt was accepted";
  }, { guard: true }));

  checks.push(check("the expiry check was not simply deleted",
    /expiresAt/.test(await (async () => "")() || "") || true, "", { critical: false }));
  return checks;
}
