/**
 * The load-bearing check runs the agent's new test against the ORIGINAL buggy
 * module. A regression test that passes there is not a regression test.
 */
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { check, guard, behaviourCheck, importFromWorkspace } from "../../_lib/checks.mjs";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "workspace");

export default async function validate({ workspace, helpers, run }) {
  const checks = [];

  const suite = await helpers.run("node --test", { timeoutMs: 60000 });
  checks.push(check("the whole suite passes after the fix", suite.ok,
    `node --test exited ${suite.code}:\n${suite.output.slice(0, 900)}`));

  checks.push(await behaviourCheck("the bug itself is fixed", async () => {
    const mod = await importFromWorkspace(workspace, "duration.mjs");
    if (mod.parseDuration("1h30m") !== 90) return `parseDuration("1h30m") = ${mod.parseDuration("1h30m")}, expected 90`;
    if (mod.parseDuration("2h") !== 120) return "an existing case regressed";
    if (mod.parseDuration("") !== 0) return "empty input regressed";
  }));

  const files = await helpers.listFiles();
  const tests = files.filter((f) => /\.test\.mjs$/.test(f));
  checks.push(check("a test covers the reported case",
    (await Promise.all(tests.map((f) => helpers.read(f)))).some((b) => /1h30m/.test(b ?? "")),
    `no test mentions the reported input. Test files: ${tests.join(", ")}`));

  // The real question: would that test have caught the bug?
  checks.push(await behaviourCheck("the new test FAILS against the original buggy module", async () => {
    const probe = await fs.mkdtemp(path.join(workspace, ".probe-"));
    try {
      await fs.writeFile(path.join(probe, "duration.mjs"), await fs.readFile(path.join(FIXTURE, "duration.mjs"), "utf-8"));
      await fs.writeFile(path.join(probe, "package.json"), JSON.stringify({ name: "p", type: "module" }));
      let copied = 0;
      for (const f of tests) {
        const body = await helpers.read(f);
        if (!body || !/1h30m/.test(body)) continue;
        await fs.writeFile(path.join(probe, path.basename(f)), body.replace(/from\s+["'][^"']*duration\.mjs["']/g, 'from "./duration.mjs"'));
        copied++;
      }
      if (!copied) return "no test referenced the bug, so nothing could be replayed against the old code";
      const res = await helpers.run(`cd "${probe}" && node --test`, { timeoutMs: 60000 });
      if (res.ok) return "the new test PASSES against the original buggy module — it documents the bug rather than catching it";
    } finally {
      await fs.rm(probe, { recursive: true, force: true }).catch(() => {});
    }
  }));

  const original = await fs.readFile(path.join(FIXTURE, "duration.test.mjs"), "utf-8");
  checks.push(check("the pre-existing tests were not weakened",
    ((await helpers.read("duration.test.mjs")) ?? "").includes(original.trim().split("\n").slice(-3).join("\n").trim()) ||
      original.split("\n").filter((l) => l.startsWith("test(")).every((l) => files.some(async (f) => ((await helpers.read(f)) ?? "").includes(l))),
    "the original assertions were removed or altered", { critical: false, guard: true }));
  return checks;
}
