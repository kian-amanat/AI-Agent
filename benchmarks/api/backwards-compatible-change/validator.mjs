/** The old caller is the contract. It is run unmodified. */
import { check, guard, behaviourCheck, importFromWorkspace } from "../../_lib/checks.mjs";

export default async function validate({ workspace, run }) {
  const checks = [];
  let s = null; let legacy = null;
  checks.push(await behaviourCheck("both modules still load", async () => {
    s = await importFromWorkspace(workspace, "search.mjs");
    legacy = await importFromWorkspace(workspace, "legacy.mjs");
    if (typeof s.search !== "function") return "search is no longer exported";
  }, { guard: true }));
  if (!s?.search) return checks;

  checks.push(await behaviourCheck("the existing caller is unaffected", () => {
    const got = legacy.titlesFor("al");
    if (got !== "alpha,alfalfa,alpine,alabaster") return `legacy caller now returns ${JSON.stringify(got)}`;
  }, { guard: true }));

  checks.push(await behaviourCheck("one-argument search is unchanged", () => {
    const got = s.search("al");
    if (!Array.isArray(got)) return `the return type changed to ${typeof got} — every existing caller breaks`;
    if (got.length !== 4) return `expected 4 results, got ${got.length}`;
    if (got[0]?.title !== "alpha") return "result order changed";
  }, { guard: true }));

  checks.push(await behaviourCheck("limit caps the results", () => {
    const got = s.search("al", { limit: 2 });
    if (!Array.isArray(got) || got.length !== 2) return `expected 2, got ${JSON.stringify(got)}`;
    if (got[0]?.title !== "alpha") return "limit changed the ordering";
  }));

  checks.push(await behaviourCheck("offset skips results", () => {
    const got = s.search("al", { offset: 2 });
    if (!Array.isArray(got) || got.length !== 2) return `expected 2 remaining, got ${JSON.stringify(got)}`;
    if (got[0]?.title !== "alpine") return `offset landed on ${got[0]?.title}`;
  }));

  checks.push(await behaviourCheck("limit and offset combine", () => {
    const got = s.search("al", { limit: 1, offset: 1 });
    if (got?.length !== 1 || got[0]?.title !== "alfalfa") return `got ${JSON.stringify(got)}`;
  }));

  checks.push(await behaviourCheck("an empty options object behaves like no options", () => {
    if (s.search("al", {}).length !== 4) return "passing {} changed the default result set";
  }, { guard: true }));

  checks.push(check("legacy.mjs was not edited to accommodate the change",
    !run.workspaceChanges.changed.includes("legacy.mjs"),
    "the existing caller was modified — that is a breaking change with extra steps"));
  return checks;
}
