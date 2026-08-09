/** Counted, not timed — the assertions are integers. */
import { check, guard, behaviourCheck, importFromWorkspace } from "../../_lib/checks.mjs";

export default async function validate({ workspace }) {
  const checks = [];
  let m = null;
  checks.push(await behaviourCheck("cache.mjs still loads", async () => {
    m = await importFromWorkspace(workspace, "cache.mjs");
    if (typeof m.getUser !== "function") return "getUser is no longer exported";
  }, { guard: true }));
  if (!m?.getUser) return checks;

  checks.push(await behaviourCheck("a single call still returns the user", async () => {
    m.resetFetchCount(); m.setShouldFail(false);
    const u = await m.getUser("u1");
    if (u?.name !== "user-u1") return `got ${JSON.stringify(u)}`;
  }, { guard: true }));

  checks.push(await behaviourCheck("ten concurrent calls for one id cause ONE fetch", async () => {
    m.resetFetchCount(); m.setShouldFail(false);
    const all = await Promise.all(Array.from({ length: 10 }, () => m.getUser("stampede")));
    const n = m.getFetchCount();
    if (n !== 1) return `${n} fetches for 10 concurrent callers — each miss still starts its own`;
    if (!all.every((u) => u?.id === "stampede")) return "callers received inconsistent values";
  }));

  checks.push(await behaviourCheck("different ids still fetch independently", async () => {
    m.resetFetchCount(); m.setShouldFail(false);
    await Promise.all([m.getUser("a"), m.getUser("b")]);
    const n = m.getFetchCount();
    if (n !== 2) return `expected 2 fetches for 2 distinct ids, got ${n} — ids are being serialised together`;
  }, { guard: true }));

  // Genuine progress, and the case a naive per-key lock gets wrong: dedupe must
  // be PER ID, so ten callers across two ids cost exactly two fetches.
  checks.push(await behaviourCheck("concurrent callers across two ids cost exactly two fetches", async () => {
    m.resetFetchCount(); m.setShouldFail(false);
    await Promise.all([
      ...Array.from({ length: 5 }, () => m.getUser("x")),
      ...Array.from({ length: 5 }, () => m.getUser("y")),
    ]);
    const n = m.getFetchCount();
    if (n !== 2) return `10 concurrent callers across 2 ids caused ${n} fetches, expected 2`;
  }));

  checks.push(await behaviourCheck("a later call is served from cache", async () => {
    m.resetFetchCount(); m.setShouldFail(false);
    await m.getUser("warm"); const after = m.getFetchCount();
    await m.getUser("warm");
    if (m.getFetchCount() !== after) return "the cache no longer serves repeat reads";
  }, { guard: true }));

  checks.push(await behaviourCheck("a failed fetch is NOT cached", async () => {
    m.resetFetchCount(); m.setShouldFail(true);
    await Promise.allSettled(Array.from({ length: 3 }, () => m.getUser("flaky")));
    m.setShouldFail(false);
    const u = await m.getUser("flaky");
    if (!u || u.name !== "user-flaky") {
      return "after the upstream recovered the call still fails — a rejected promise was cached, poisoning the key forever";
    }
  }, { guard: true }));
  return checks;
}
