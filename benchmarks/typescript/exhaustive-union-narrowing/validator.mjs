/**
 * Exhaustiveness cannot be established by reading the source — a `default`
 * branch looks a lot like an assertNever until you add a variant. So this
 * validator adds one, in a throwaway copy, and asks the compiler.
 *
 * No compiler available is reported as a BLOCKER, never as a pass: a check that
 * could not run has not been satisfied.
 */
import fs from "fs/promises";
import os from "os";
import path from "path";
import { check } from "../../_lib/checks.mjs";
import { typecheck } from "../../_lib/typecheck.mjs";

export default async function validate({ workspace, helpers, run }) {
  const files = ["types.ts", "area.ts", "index.ts"].map((f) => helpers.resolve(f));

  const baseline = typecheck(files, { strict: true });
  if (!baseline.available) {
    // Surfaced to the runner as a blocker, not a failure.
    throw new Error(`cannot type-check this benchmark: ${baseline.reason}`);
  }

  const checks = [];
  const area = await helpers.read("area.ts");

  checks.push(check("the workspace typechecks under strict mode",
    baseline.errors.length === 0,
    baseline.errors.slice(0, 6).join(" | "), { guard: true }));

  checks.push(check("area no longer takes an any type",
    !/\bany\b/.test(area ?? ""),
    `area.ts still contains \`any\`:\n${String(area).slice(0, 400)}`));

  checks.push(check("area is typed against Shape",
    /function area\s*\([^)]*:\s*Shape\b/.test(area ?? "") || /\(\s*\w+\s*:\s*Shape\s*\)/.test(area ?? ""),
    "area's parameter is not annotated as Shape"));

  checks.push(check("did not silence the compiler instead of satisfying it",
    !/@ts-(?:ignore|expect-error|nocheck)/.test(area ?? ""),
    "area.ts suppresses type errors rather than fixing them", { guard: true }));

  checks.push(check("handles the rectangle variant",
    /rectangle/.test(area ?? "") && /width/.test(area ?? "") && /height/.test(area ?? ""),
    "the rectangle case is still unhandled"));

  checks.push(check("types.ts's variants were not altered",
    !run.workspaceChanges.changed.includes("types.ts"),
    "types.ts was changed — the union is the given, not the thing to edit", { guard: true }));

  // The real exhaustiveness proof: add a variant, expect a compile error.
  const probe = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-bench-exhaustive-"));
  try {
    for (const f of ["types.ts", "area.ts", "index.ts"]) {
      const src = await helpers.read(f);
      if (src === null) continue;
      await fs.writeFile(path.join(probe, f), f === "types.ts"
        ? src.replace(/;\s*$/, "") + '\n  | { kind: "triangle"; base: number; height: number };\n'
        : src, "utf-8");
    }
    const withNewVariant = typecheck(["types.ts", "area.ts", "index.ts"].map((f) => path.join(probe, f)), { strict: true });
    checks.push(check(
      "adding a new Shape variant now breaks the build (exhaustiveness is real)",
      withNewVariant.available && withNewVariant.errors.length > 0,
      "a fourth variant was added to Shape and the code still compiled — area is not exhaustive, it just has a fallback that swallows unknown shapes"
    ));
  } finally {
    await fs.rm(probe, { recursive: true, force: true }).catch(() => {});
  }

  return checks;
}
