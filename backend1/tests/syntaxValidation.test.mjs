/**
 * tests/syntaxValidation.test.mjs
 * Run with: node tests/syntaxValidation.test.mjs
 *
 * Tests the REAL utils/syntax.util.mjs — the pre-write gate that decides
 * whether an edit is allowed to reach disk. (tests/core.test.mjs exercises a
 * local stand-in; this file exercises the thing that actually runs.)
 *
 * This gate is unusually consequential: a false positive here does not merely
 * annoy, it makes a file *unwritable by the agent*. The run then burns its
 * iteration budget retrying, and ends by describing the code in prose instead
 * of applying it — which reads like "the model gave up" and is really "the
 * tooling refused". The React rule below did exactly that to every typed event
 * handler, and it is why react/command-palette-resume could never finish.
 */

import assert from "assert";
import { validateSyntax } from "../utils/syntax.util.mjs";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

const accepts = (src, ext = "tsx") => {
  const err = validateSyntax(src, `/tmp/bench-syntax/Component.${ext}`);
  assert.strictEqual(err, null, `expected this to be writable, but it was rejected: ${err}`);
};
const rejects = (src, pattern, ext = "tsx") => {
  const err = validateSyntax(src, `/tmp/bench-syntax/Component.${ext}`);
  assert.ok(err, "expected a rejection, got none");
  assert.match(err, pattern);
};

// ── React value vs type positions ───────────────────────────────────────────
console.log("\n══ React.<x> without importing React ═════════════════════════");

test("a typed keyboard handler is writable (React.KeyboardEvent is erased)", () => {
  // The exact idiom react/command-palette-resume needs, and the exact content
  // three consecutive benchmark runs had rejected.
  // No relative import: a separate rule (local imports must resolve) would
  // fire on a path that does not exist beside this temp file, and this test is
  // about the React rule only.
  accepts(`import { useState } from "react";

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const commands: { run: () => void }[] = [];

  if (!open) return null;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") onClose();
    if (e.key === "Enter") commands[selected]?.run();
  }

  return (
    <div className="palette" onKeyDown={onKeyDown}>
      <input value={query} onChange={(e) => setQuery(e.target.value)} />
    </div>
  );
}`);
});

test("React.ReactNode in a props type is writable", () => {
  accepts(`export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}`);
});

test("React.FC with a generic argument is writable", () => {
  accepts(`import { useState } from "react";
const Counter: React.FC<{ start: number }> = ({ start }) => {
  const [n, setN] = useState(start);
  return <button onClick={() => setN(n + 1)}>{n}</button>;
};
export default Counter;`);
});

test("React.ChangeEvent on a handler parameter is writable", () => {
  accepts(`import { useState } from "react";
export function Field() {
  const [v, setV] = useState("");
  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => setV(e.target.value);
  return <input value={v} onChange={onChange} />;
}`);
});

// The rule still has to do its actual job.
console.log("\n══ …but a real runtime reference is still caught ══════════════");

test("React.useRef as a value is still rejected", () => {
  rejects(
    `import { useState } from "react";
export function P() {
  const ref = React.useRef(null);
  useState();
  return <div ref={ref} />;
}`,
    /uses React\.<something> at runtime but never imports React/
  );
});

test("React.createElement as a value is still rejected", () => {
  rejects(
    `export function P() { return React.createElement("div", null, "hi"); }`,
    /at runtime but never imports React/
  );
});

test("a value reference inside a function body is still rejected", () => {
  rejects(
    `import { useState } from "react";
export function P() {
  useState();
  function inner() { return React.version; }
  return <div>{inner()}</div>;
}`,
    /at runtime but never imports React/
  );
});

test("the rejection points at the offending line", () => {
  const err = validateSyntax(
    `import { useState } from "react";\nuseState;\nconst x = React.useRef(null);\n`,
    "/tmp/bench-syntax/A.tsx"
  );
  assert.match(err, /^L3:/, `expected the line number of the value use, got: ${err}`);
});

console.log("\n══ importing React makes value use fine ══════════════════════");

test("default-importing React allows value use", () => {
  accepts(`import React from "react";
export function P() { const r = React.useRef(null); return <div ref={r} />; }`);
});

test("namespace-importing React allows value use", () => {
  accepts(`import * as React from "react";
export function P() { const r = React.useRef(null); return <div ref={r} />; }`);
});

test("mixed default + named import allows value use", () => {
  accepts(`import React, { useState } from "react";
export function P() { useState(); const r = React.useRef(null); return <div ref={r} />; }`);
});

// ── the gate's other rules must be untouched ────────────────────────────────
console.log("\n══ the rest of the gate still works ══════════════════════════");

test("genuinely broken syntax is still rejected", () => {
  rejects(`export function P() { return <div>unclosed; }`, /L\d+:/);
});

test("a valid plain component is still writable", () => {
  accepts(`import React from "react";\nexport default function A() { return <div>hi</div>; }`);
});

test('a "use client" file exporting metadata is still rejected', () => {
  rejects(
    `"use client";\nexport const metadata = { title: "x" };\nexport default function P() { return <div />; }`,
    /use client/
  );
});

console.log(`\n${"═".repeat(62)}`);
console.log(`  syntax validation: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(62)}\n`);
process.exit(failed === 0 ? 0 : 1);
