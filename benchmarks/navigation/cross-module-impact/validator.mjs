/**
 * Every call site is exercised through its real export. A missed one shows up
 * as the wrong symbol, not as a missing edit.
 */
import { check, guard, behaviourCheck, importFromWorkspace } from "../../_lib/checks.mjs";

const EXPECTED = [
  ["renderCheckout", "$12.34"],
  ["renderInvoices", "\u20ac12.34"],
  ["renderPayouts", "\u00a312.34"],
  ["renderRefunds", "\u00a512.34"],
  ["renderReports", "CHF 12.34"],
];
const DECOYS = ["src/pages/settings.mjs", "src/pages/profile.mjs", "src/pages/about.mjs"];

export default async function validate({ workspace, helpers, run }) {
  const checks = [];
  let idx = null;
  checks.push(await behaviourCheck("the tree still loads", async () => {
    idx = await importFromWorkspace(workspace, "src/index.mjs");
  }, { guard: true }));
  if (!idx) return checks;

  for (const [fn, want] of EXPECTED) {
    // renderCheckout is USD, which the un-updated code already produces — it is
    // a guard against regressing the one site that happens to look right.
    const isAlreadyCorrect = fn === "renderCheckout";
    checks.push(await behaviourCheck(`${fn} formats in its own currency`, () => {
      if (typeof idx[fn] !== "function") return `${fn} is gone`;
      const got = idx[fn](1234);
      if (got !== want) return `${fn}(1234) = ${JSON.stringify(got)}, expected ${JSON.stringify(want)} — this call site was not updated`;
    }, { guard: isAlreadyCorrect }));
  }

  const money = await helpers.read("src/lib/money.mjs");
  checks.push(check("formatMoney takes an explicit currency argument",
    /function formatMoney\s*\([^)]*,[^)]*\)/.test(money ?? ""),
    "formatMoney still takes a single parameter"));
  checks.push(check("no default hides an un-updated call site",
    !/function formatMoney\s*\([^)]*=\s*["']USD["']/.test(money ?? ""),
    "a default currency lets a missed call site keep working silently — the task said every site must pass it explicitly"));

  const touchedDecoys = run.workspaceChanges.changed.filter((f) => DECOYS.includes(f));
  checks.push(check("did not edit the modules that never format money", touchedDecoys.length === 0,
    `edited ${touchedDecoys.join(", ")} — they declare CURRENCY but never call formatMoney`, { critical: false }));
  return checks;
}
