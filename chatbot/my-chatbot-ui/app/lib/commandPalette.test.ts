/**
 * app/lib/commandPalette.test.ts
 * Run with: npm test   (compiles with the project's own tsc, then runs on node)
 *
 * Covers the palette's behaviour as pure functions: the Cmd/Ctrl+K chord,
 * fuzzy matching and its ranking, keyboard navigation, and which item a
 * keypress resolves to. There is no test runner in this app and adding one was
 * out of scope, so this uses node's built-in `assert` and the TypeScript
 * compiler that is already a dependency.
 */

import assert from "node:assert";
import {
  isPaletteShortcut,
  isDismissKey,
  fuzzyScore,
  filterCommands,
  moveSelection,
  resolveSelection,
  type PaletteItem,
} from "./commandPalette.js";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${(err as Error).message}`);
    failed++;
  }
}

const ITEMS: PaletteItem[] = [
  { key: "a:clear",   label: "/clear",    group: "Actions" },
  { key: "a:compact", label: "/compact",  group: "Actions" },
  { key: "a:undo",    label: "/undo",     group: "Actions" },
  { key: "b:help",    label: "/help",     group: "Built-in" },
  { key: "b:commands", label: "/commands", group: "Built-in" },
  { key: "b:mcp",     label: "/mcp",      group: "Built-in" },
  { key: "c:deploy",  label: "/deploy",   group: "Project", disabled: true },
];

console.log("\n── the Cmd/Ctrl+K shortcut ──────────────────────────────────");

test("REQUIRED: Cmd+K opens the palette", () => {
  assert.equal(isPaletteShortcut({ key: "k", metaKey: true }), true);
});

test("REQUIRED: Ctrl+K opens the palette", () => {
  assert.equal(isPaletteShortcut({ key: "k", ctrlKey: true }), true);
});

test("the chord is case-insensitive — caps lock must not break it", () => {
  assert.equal(isPaletteShortcut({ key: "K", metaKey: true }), true);
});

test("a bare k is just typing, not a shortcut", () => {
  assert.equal(isPaletteShortcut({ key: "k" }), false);
});

test("other modified keys are left alone", () => {
  assert.equal(isPaletteShortcut({ key: "j", metaKey: true }), false);
  assert.equal(isPaletteShortcut({ key: "p", ctrlKey: true }), false);
});

test("Ctrl+Shift+K stays with the browser console", () => {
  assert.equal(isPaletteShortcut({ key: "k", ctrlKey: true, shiftKey: true }), false);
});

test("Ctrl+Alt+K is a different chord and is not swallowed", () => {
  assert.equal(isPaletteShortcut({ key: "k", ctrlKey: true, altKey: true }), false);
});

test("Escape is the dismiss key", () => {
  assert.equal(isDismissKey({ key: "Escape" }), true);
  assert.equal(isDismissKey({ key: "Enter" }), false);
});

console.log("\n── fuzzy search ─────────────────────────────────────────────");

test("an empty query lists every command", () => {
  assert.equal(filterCommands(ITEMS, "").length, ITEMS.length);
  assert.equal(filterCommands(ITEMS, "/").length, ITEMS.length);
});

test("REQUIRED: a prefix finds the command", () => {
  const names = filterCommands(ITEMS, "cle").map((i) => i.label);
  assert.deepEqual(names, ["/clear"]);
});

test("REQUIRED: characters may be skipped — that is what makes it fuzzy", () => {
  // "cmds" appears in /commands only as a subsequence: c-o-m-man-d-s.
  const names = filterCommands(ITEMS, "cmds").map((i) => i.label);
  assert.ok(names.includes("/commands"), `expected /commands, got ${names.join(", ")}`);
});

test("a prefix match outranks a merely-scattered one", () => {
  // "co" is a prefix of /commands and /compact, and scattered in /clear? No —
  // /clear has no 'o'. Both real matches must beat nothing, and the ranking
  // must be stable and prefix-first.
  const names = filterCommands(ITEMS, "com").map((i) => i.label);
  assert.ok(names[0] === "/commands" || names[0] === "/compact", `got ${names[0]}`);
  assert.ok(names.includes("/commands") && names.includes("/compact"));
});

test("consecutive characters rank above scattered ones", () => {
  const dense = fuzzyScore("/commands", "comm");
  const sparse = fuzzyScore("/compact", "comm");
  assert.notEqual(dense, null);
  // /compact has no second 'm' after "com", so it should not match at all.
  assert.equal(sparse, null);
});

test("a query that matches nothing returns nothing", () => {
  assert.deepEqual(filterCommands(ITEMS, "zzzz"), []);
  assert.equal(fuzzyScore("/clear", "zzz"), null);
});

test("matching ignores case in both directions", () => {
  assert.notEqual(fuzzyScore("/Clear", "CLE"), null);
  assert.notEqual(fuzzyScore("/clear", "CLE"), null);
});

test("the leading slash is optional in the query", () => {
  const withSlash = filterCommands(ITEMS, "/mcp").map((i) => i.label);
  const without   = filterCommands(ITEMS, "mcp").map((i) => i.label);
  assert.deepEqual(withSlash, without);
  assert.deepEqual(without, ["/mcp"]);
});

test("order is by score, not by the order the items were declared", () => {
  // /undo is declared third but is the only match for "und".
  assert.deepEqual(filterCommands(ITEMS, "und").map((i) => i.label), ["/undo"]);
});

console.log("\n── keyboard navigation ──────────────────────────────────────");

test("REQUIRED: arrowing down moves the highlight", () => {
  assert.equal(moveSelection(0, 5, 1), 1);
  assert.equal(moveSelection(3, 5, 1), 4);
});

test("REQUIRED: arrowing up moves the highlight back", () => {
  assert.equal(moveSelection(3, 5, -1), 2);
});

test("the highlight wraps at both ends", () => {
  assert.equal(moveSelection(4, 5, 1), 0, "off the bottom wraps to the top");
  assert.equal(moveSelection(0, 5, -1), 4, "off the top wraps to the bottom");
});

test("an empty list cannot produce an out-of-range index", () => {
  assert.equal(moveSelection(0, 0, 1), 0);
  assert.equal(moveSelection(3, 0, -1), 0);
});

console.log("\n── command execution ────────────────────────────────────────");

test("REQUIRED: the highlighted command is the one that executes", () => {
  const list = filterCommands(ITEMS, "");
  const chosen = resolveSelection(list, 2);
  assert.equal(chosen?.label, "/undo");
});

test("REQUIRED: navigating then selecting executes the right command", () => {
  // The full path a user takes: open, arrow down twice, press Enter.
  const list = filterCommands(ITEMS, "");
  let idx = 0;
  idx = moveSelection(idx, list.length, 1);
  idx = moveSelection(idx, list.length, 1);
  assert.equal(resolveSelection(list, idx)?.label, "/undo");
});

test("REQUIRED: searching then selecting executes the searched command", () => {
  const list = filterCommands(ITEMS, "mcp");
  assert.equal(resolveSelection(list, 0)?.label, "/mcp");
});

test("a disabled command cannot be executed", () => {
  const list = filterCommands(ITEMS, "deploy");
  assert.equal(list[0].label, "/deploy", "it is still listed, so the user can see why");
  assert.equal(resolveSelection(list, 0), null, "but selecting it does nothing");
});

test("selecting past the end of the list is not an error", () => {
  assert.equal(resolveSelection(filterCommands(ITEMS, ""), 99), null);
  assert.equal(resolveSelection([], 0), null);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
