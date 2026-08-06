/**
 * Deterministic performance measurement: the dataset counts its own scans, so
 * "is it faster" becomes "how many scans did 100 calls cost" — an integer, not
 * a stopwatch. Correctness is checked first; a fast wrong answer is not a win.
 */
import { check, behaviourCheck, importFromWorkspace } from "../../_lib/checks.mjs";

export default async function validate({ workspace, helpers, run }) {
  const checks = [];

  let lookup = null, dataset = null;
  checks.push(await behaviourCheck("the modules still load", async () => {
    // No cache-busting query here, deliberately. lookup.mjs imports
    // "./dataset.mjs" by that plain specifier; a busted specifier would resolve
    // to a SECOND instance of the module with its own scanCount, and every
    // measurement below would read a counter nothing was incrementing. The
    // workspace path is already unique per run, so nothing needs busting.
    dataset = await importFromWorkspace(workspace, "dataset.mjs");
    lookup = await importFromWorkspace(workspace, "lookup.mjs");
    if (typeof lookup.expensiveLookup !== "function") return "lookup.mjs no longer exports expensiveLookup";
    if (typeof dataset.getScanCount !== "function") return "dataset.mjs no longer exports getScanCount";
  }, { guard: true }));
  if (!lookup?.expensiveLookup) return checks;

  checks.push(await behaviourCheck("still returns the right record for a hit", () => {
    const got = lookup.expensiveLookup("k500");
    if (got?.key !== "k500" || got?.value !== 1500) return `expensiveLookup("k500") returned ${JSON.stringify(got)}`;
  }, { guard: true }));

  checks.push(await behaviourCheck("still returns null for a miss", () => {
    const got = lookup.expensiveLookup("not-a-key");
    if (got !== null) return `expected null for an unknown key, got ${JSON.stringify(got)}`;
  }, { guard: true }));

  checks.push(await behaviourCheck("distinct keys still resolve independently", () => {
    for (const i of [0, 1, 999, 1999]) {
      const got = lookup.expensiveLookup(`k${i}`);
      if (got?.value !== i * 3) return `expensiveLookup("k${i}") returned ${JSON.stringify(got)}`;
    }
  }, { guard: true }));

  // The measurement. 100 repeated calls must not cost 100 scans.
  checks.push(await behaviourCheck("100 repeated lookups of the same key cost at most one scan", () => {
    dataset.resetScanCount?.();
    const before = dataset.getScanCount();
    for (let i = 0; i < 100; i++) lookup.expensiveLookup("k1234");
    const scans = dataset.getScanCount() - before;
    if (scans > 1) return `100 identical lookups triggered ${scans} full scans — the result is not being reused`;
  }));

  checks.push(await behaviourCheck("repeated MISSES are cached too", () => {
    const before = dataset.getScanCount();
    for (let i = 0; i < 50; i++) lookup.expensiveLookup("still-not-a-key");
    const scans = dataset.getScanCount() - before;
    if (scans > 1) return `50 identical misses triggered ${scans} scans — a key that is absent is just as expensive to look up`;
  }));

  checks.push(check("dataset.mjs was left alone",
    !run.workspaceChanges.changed.includes("dataset.mjs"),
    "dataset.mjs is the slow data source being worked around, not the thing to edit",
    { critical: false }));

  return checks;
}
