/**
 * Behaviour through the real entry point. The decoys are unreachable from
 * src/index.mjs, so editing one cannot make these checks pass.
 */
import { check, guard, behaviourCheck, importFromWorkspace } from "../../_lib/checks.mjs";

const CASES = [["USD", "$"], ["EUR", "\u20ac"], ["GBP", "\u00a3"], ["JPY", "\u00a5"]];
const DECOYS = [
  "src/utils/currencyUtils.mjs", "src/utils/priceFormatter.mjs",
  "src/utils/money.mjs", "src/components/formatPrice.mjs",
];

export default async function validate({ workspace, run }) {
  const checks = [];
  let mod = null;
  checks.push(await behaviourCheck("the entry point still loads", async () => {
    mod = await importFromWorkspace(workspace, "src/index.mjs");
    if (typeof mod.formatPrice !== "function") return "formatPrice is no longer exported";
  }, { guard: true }));
  if (!mod?.formatPrice) return checks;

  checks.push(await behaviourCheck("USD still renders correctly", () => {
    const got = mod.formatPrice({ currency: "USD", amount: 10 });
    if (got !== "$10.00") return `got ${JSON.stringify(got)}`;
  }, { guard: true }));

  for (const [code, symbol] of CASES.slice(1)) {
    checks.push(await behaviourCheck(`${code} renders with ${symbol}`, () => {
      const got = mod.formatPrice({ currency: code, amount: 10 });
      if (got !== `${symbol}10.00`) return `formatPrice({currency:"${code}"}) = ${JSON.stringify(got)}`;
    }));
  }

  checks.push(await behaviourCheck("an unknown currency does not crash", () => {
    const got = mod.formatPrice({ currency: "XYZ", amount: 1 });
    if (typeof got !== "string") return `returned ${JSON.stringify(got)}`;
  }, { critical: false }));

  const touchedDecoys = run.workspaceChanges.changed.filter((f) => DECOYS.includes(f));
  checks.push(check("did not edit the decoy modules", touchedDecoys.length === 0,
    `edited unused/dead modules: ${touchedDecoys.join(", ")} — these are not on the live path`,
    { critical: false }));
  checks.push(check("kept the change small",
    run.workspaceChanges.changed.length <= 2,
    `changed ${run.workspaceChanges.changed.length} files: ${run.workspaceChanges.changed.slice(0, 8).join(", ")}`,
    { critical: false }));
  return checks;
}
