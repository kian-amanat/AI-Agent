/**
 * Behaviour is pinned by a table; structure is checked separately. A refactor
 * that satisfies only one of those is not a refactor.
 */
import { check, guard, behaviourCheck, importFromWorkspace } from "../../_lib/checks.mjs";

const CART = [{ price: 10, qty: 2 }, { price: 5.5, qty: 3 }];
const CASES = [
  ["cartSubtotal", [[]], 0],
  ["cartSubtotal", [CART], 36.5],
  ["cartSubtotal", [[{ price: 9.99, qty: 0 }]], 0],
  ["applyDiscount", [100, 0], 100],
  ["applyDiscount", [100, 10], 90],
  ["applyDiscount", [100, 150], 0],
  ["applyDiscount", [33.33, 33], 22.33],
  ["cartTotal", [CART, 10], 32.85],
  ["cartTotal", [[], 50], 0],
  ["displayName", [{ first: "Ada", last: "Lovelace" }], "Ada Lovelace"],
  ["displayName", [{ first: "Prince" }], "Prince"],
  ["displayName", [{}], "Anonymous"],
  ["displayName", [{ first: "  Ada  ", last: "  " }], "Ada"],
  ["initials", [{ first: "Ada", last: "Lovelace" }], "AL"],
  ["initials", [{}], "??"],
  ["isLeapYear", [2024], true],
  ["isLeapYear", [1900], false],
  ["isLeapYear", [2000], true],
  ["daysInMonth", [2024, 2], 29],
  ["daysInMonth", [2023, 2], 28],
  ["isValidEmail", ["a@b.co"], true],
  ["isValidEmail", ["a@@b.co"], false],
  ["isValidQty", [1], true],
  ["isValidQty", [0], false],
  ["isValidQty", [1.5], false],
];
const EXPORTS = ["cartSubtotal","applyDiscount","cartTotal","displayName","initials","isLeapYear","daysInMonth","isValidEmail","isValidQty"];

export default async function validate({ workspace, helpers, run }) {
  const checks = [];
  let mod = null;
  checks.push(await behaviourCheck("the public API still loads", async () => {
    mod = await importFromWorkspace(workspace, "index.mjs");
  }, { guard: true }));
  if (!mod) return checks;

  checks.push(check("index.mjs still exports exactly the same names",
    EXPORTS.every((n) => typeof mod[n] === "function"),
    `missing: ${EXPORTS.filter((n) => typeof mod[n] !== "function").join(", ")}`, { guard: true }));

  checks.push(await behaviourCheck("every public function behaves identically", () => {
    for (const [fn, args, want] of CASES) {
      if (typeof mod[fn] !== "function") return `${fn} is gone`;
      const got = mod[fn](...args);
      if (got !== want) return `${fn}(${JSON.stringify(args)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`;
    }
  }, { guard: true }));

  // Structure: the split has to have actually happened.
  const files = await helpers.listFiles();
  const modules = files.filter((f) => f.endsWith(".mjs") && !/\.test\.mjs$/.test(f) && f !== "index.mjs");
  checks.push(check("the concerns were split across several modules", modules.length >= 3,
    `only ${modules.length} module(s) besides index.mjs: ${modules.join(", ")} — one grab-bag replaced by another is not a split`));

  const store = await helpers.read("store.mjs");
  const concernsLeft = store === null ? 0 :
    ["cartSubtotal", "displayName", "isLeapYear", "isValidEmail"].filter((n) => new RegExp(`function \\s*${n}\\b|${n}\\s*=`).test(store)).length;
  checks.push(check("store.mjs no longer holds every concern", concernsLeft <= 1,
    `store.mjs still defines ${concernsLeft} of the 4 concerns`));

  // A split that only re-exports from index has moved nothing.
  const idx = await helpers.read("index.mjs");
  checks.push(check("index.mjs pulls from more than one module",
    new Set([...(idx ?? "").matchAll(/from\s*["']([^"']+)["']/g)].map((m) => m[1])).size >= 2,
    "index.mjs still sources everything from a single module"));

  checks.push(check("each new module is meaningfully sized",
    modules.length === 0 || (await Promise.all(modules.map(async (f) => ((await helpers.read(f)) ?? "").trim().length))).every((n) => n > 40),
    "one of the new modules is essentially empty", { critical: false }));
  return checks;
}
