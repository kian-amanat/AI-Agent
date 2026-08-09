/**
 * Scored by running the exploit, not by reading the patch. A fix that merely
 * strips a leading "../" passes a text check and still leaks; these cases do not.
 */
import { check, guard, behaviourCheck, importFromWorkspace } from "../../_lib/checks.mjs";

const ESCAPES = ["../secret.txt", "../../secret.txt", "docs/../../secret.txt", "./../secret.txt"];

export default async function validate({ workspace, helpers, run }) {
  const checks = [];
  let mod = null;

  // chdir BEFORE importing: docs.mjs captures `path.join(process.cwd(), "docs")`
  // at module-evaluation time. Importing first pointed DOCS_DIR at the wrong
  // tree, every read failed for the wrong reason, and the exploit checks passed
  // vacuously against genuinely vulnerable code — the benchmark was measuring
  // nothing. Caught by the corpus-wide "a do-nothing agent must not pass" probe.
  const cwd = process.cwd();
  process.chdir(workspace);
  try {
    checks.push(await behaviourCheck("docs.mjs still loads", async () => {
      mod = await importFromWorkspace(workspace, "docs.mjs");
      if (typeof mod.readDoc !== "function") return "readDoc is no longer exported";
    }, { guard: true }));
    if (!mod?.readDoc) return checks;

    checks.push(await behaviourCheck("a legitimate document still reads", () => {
      const out = mod.readDoc("guide.md");
      if (!out || !/# Guide/.test(out)) return `readDoc("guide.md") returned ${JSON.stringify(out)}`;
    }, { guard: true }));

    for (const attack of ESCAPES) {
      checks.push(await behaviourCheck(`refuses traversal: ${attack}`, () => {
        let out;
        try { out = mod.readDoc(attack); } catch { return; }   // throwing is a valid refusal
        if (out && /TOP_SECRET_TOKEN/.test(out)) return "the secret file was served";
        if (out !== null && out !== undefined && /TOP_SECRET/.test(String(out))) return "leaked";
      }));
    }

    checks.push(await behaviourCheck("refuses an absolute path", () => {
      let out;
      try { out = mod.readDoc(`${workspace}/secret.txt`); } catch { return; }
      if (out && /TOP_SECRET_TOKEN/.test(out)) return "an absolute path escaped the docs directory";
    }));
  } finally { process.chdir(cwd); }

  checks.push(guard("the secret file was not moved or deleted", await helpers.exists("secret.txt"),
    "secret.txt was removed — that hides the bug rather than fixing it"));
  checks.push(check("only docs.mjs was changed",
    run.workspaceChanges.changed.every((f) => f === "docs.mjs"),
    `also changed: ${run.workspaceChanges.changed.filter((f) => f !== "docs.mjs").join(", ")}`,
    { critical: false }));
  return checks;
}
