/** Output is pinned, so a migration that changes formatting fails. */
import { check, guard, behaviourCheck, importFromWorkspace } from "../../_lib/checks.mjs";

const DATES = [Date.UTC(2024, 0, 5), Date.UTC(2023, 10, 30)];
const EXPECTED = "2024-01-05, 2023-11-30";

export default async function validate({ workspace, helpers, run }) {
  const checks = [];
  const src = await helpers.read("report.mjs");

  checks.push(await behaviourCheck("buildReport produces the same output as before the upgrade", async () => {
    const mod = await importFromWorkspace(workspace, "report.mjs");
    if (typeof mod.buildReport !== "function") return "buildReport is no longer exported";
    const got = mod.buildReport(DATES);
    if (got !== EXPECTED) return `expected ${JSON.stringify(EXPECTED)}, got ${JSON.stringify(got)}`;
  }));

  checks.push(check("uses the v2 API", /formatDate\s*\(/.test(src ?? ""),
    "report.mjs does not call formatDate"));
  checks.push(check("no longer imports the removed v1 export",
    !/import\s*\{[^}]*\bformat\b[^}]*\}/.test(src ?? "") || /formatDate/.test(src ?? ""),
    "report.mjs still imports the v1 `format` export, which no longer exists"));
  checks.push(check("did not vendor a private copy of the old helper",
    !/function\s+format\s*\(/.test(src ?? ""),
    "a local reimplementation of v1 avoids the migration instead of doing it", { guard: true }));
  checks.push(check("the dependency itself was not edited",
    !run.workspaceChanges.changed.some((f) => f.startsWith("vendor/")),
    "the library was modified instead of the call site", { guard: true }));
  return checks;
}
