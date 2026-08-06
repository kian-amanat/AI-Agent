/**
 * Scored from the two files on disk — not from what the agent said it did.
 * The wiring check is the one that matters: a helper nothing calls is not the
 * task.
 */
import path from "path";
import { check } from "../../_lib/checks.mjs";
import { typecheck } from "../../_lib/typecheck.mjs";

export default async function validate({ workspace, helpers, run }) {
  const utils = await helpers.read("utils.ts");
  const app = await helpers.read("App.tsx");
  const checks = [];

  checks.push(check("utils.ts still exists", utils !== null, "utils.ts is gone", { guard: true }));
  checks.push(check("App.tsx still exists", app !== null, "App.tsx is gone", { guard: true }));

  const declaresHelper = /export\s+(?:function|const)\s+formatCurrency/.test(utils ?? "");
  checks.push(check(
    "utils.ts exports formatCurrency",
    declaresHelper,
    `no exported formatCurrency in utils.ts. Contents: ${String(utils).slice(0, 300)}`
  ));

  checks.push(check(
    "formatCurrency is typed (amount: number) => string",
    /formatCurrency\s*[:(][^)]*\bnumber\b/.test(utils ?? ""),
    "formatCurrency does not declare a numeric parameter type"
  ));

  // Wiring: App.tsx must import it AND call it. Either alone is half the task.
  const importsHelper = /import[^;]*\bformatCurrency\b[^;]*from\s*["'][^"']*utils["']/.test(app ?? "");
  const callsHelper = /formatCurrency\s*\(/.test(app ?? "");
  checks.push(check("App.tsx imports formatCurrency from utils", importsHelper,
    "App.tsx has no import of formatCurrency from ./utils"));
  checks.push(check("App.tsx actually calls formatCurrency", callsHelper,
    "formatCurrency is never invoked in App.tsx — the helper was added but never wired up"));
  checks.push(check("App.tsx renders the requested price (42.5)", /42\.5/.test(app ?? ""),
    "the value 42.5 never reaches formatCurrency in App.tsx"));

  checks.push(check("slugify was left alone", /export function slugify/.test(utils ?? ""),
    "the pre-existing slugify export was removed or renamed", { guard: true }));

  // A real parser, not a regex, for "is this still valid TypeScript". Parse-only
  // because this fixture has no node_modules: full semantic checking would fail
  // forever on missing React types, which says nothing about the agent's work.
  const tc = typecheck([path.join(workspace, "utils.ts"), path.join(workspace, "App.tsx")], { jsx: true, parseOnly: true });
  checks.push(check(
    "both files still parse as valid TypeScript/TSX",
    // No compiler available is an environment gap, not a failure — and the
    // structural checks above already establish the outcome, so this stays advisory.
    !tc.available || tc.errors.length === 0,
    tc.errors.slice(0, 5).join(" | "),
    { critical: false, guard: true }
  ));

  checks.push(check(
    "changed exactly the two files it needed to",
    run.workspaceChanges.changed.every((f) => f === "utils.ts" || f === "App.tsx"),
    `also changed: ${run.workspaceChanges.changed.filter((f) => f !== "utils.ts" && f !== "App.tsx").join(", ")}`,
    { critical: false }
  ));

  return checks;
}
