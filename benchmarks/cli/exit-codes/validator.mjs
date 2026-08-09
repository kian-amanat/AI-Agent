/** Spawns the real CLI and reads real exit codes. */
import { check, guard, behaviourCheck, importFromWorkspace } from "../../_lib/checks.mjs";

export default async function validate({ helpers, run }) {
  const checks = [];

  const ok = await helpers.run("node cli.mjs Ada", { timeoutMs: 20000 });
  checks.push(check("success still prints the greeting", /hello, Ada/.test(ok.output),
    `stdout was: ${ok.output.slice(0, 200)}`, { guard: true }));
  checks.push(check("success still exits 0", ok.code === 0, `exited ${ok.code}`, { guard: true }));

  const bad = await helpers.run("node cli.mjs", { timeoutMs: 20000 });
  checks.push(check("missing argument exits non-zero", bad.code !== 0,
    `exited ${bad.code} — the shell cannot tell this failed`));
  checks.push(check("missing argument still explains itself", /usage/i.test(bad.output),
    `output was: ${bad.output.slice(0, 200)}`));
  checks.push(check("the usage message goes to stderr", /usage/i.test(bad.stderr),
    "usage was printed to stdout; diagnostics belong on stderr", { critical: false }));

  checks.push(check("only cli.mjs was changed",
    run.workspaceChanges.changed.every((f) => f === "cli.mjs"),
    `also changed: ${run.workspaceChanges.changed.join(", ")}`, { critical: false }));
  return checks;
}
