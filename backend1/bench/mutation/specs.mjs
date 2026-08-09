/**
 * bench/mutation/specs.mjs
 * The known-good solution and the deliberate wrong answers for each benchmark.
 *
 * Each mutation names a REAL way an agent gets something almost right:
 * implementing the happy path and skipping the edge case, satisfying the letter
 * of the request while breaking what was already there, writing tests that
 * assert nothing, "fixing" a vulnerability by blocking one spelling of the
 * attack. If a validator survives one of these, that shape of wrong answer
 * scores as a pass and the benchmark is not measuring what it claims to.
 */

import { put, patch } from "./index.mjs";

export function specsFor(corpus) {
  const by = (id) => corpus.find((b) => b.id === id);
  const specs = [];
  const add = (id, solution, mutations) => {
    const benchmark = by(id);
    if (benchmark) specs.push({ benchmark, solution, mutations });
  };

  // ── security: the exploit must actually be blocked ────────────────────────
  add("security/path-traversal-fix",
    (ws) => put(ws, "docs.mjs", `import fs from "fs";
import path from "path";
const DOCS_DIR = path.join(process.cwd(), "docs");
export function readDoc(name) {
  const target = path.resolve(DOCS_DIR, name);
  if (target !== DOCS_DIR && !target.startsWith(DOCS_DIR + path.sep)) return null;
  try { return fs.readFileSync(target, "utf-8"); } catch { return null; }
}
`),
    [
      {
        name: "a bypass: only a literal '../' prefix is stripped",
        expectCheck: "refuses traversal",
        apply: (ws) => put(ws, "docs.mjs", `import fs from "fs";
import path from "path";
const DOCS_DIR = path.join(process.cwd(), "docs");
export function readDoc(name) {
  const clean = String(name).replace(/^\\.\\.\\//, "");
  try { return fs.readFileSync(path.join(DOCS_DIR, clean), "utf-8"); } catch { return null; }
}
`),
      },
      {
        name: "the fix blocks everything, including valid reads",
        expectCheck: "legitimate document",
        apply: (ws) => patch(ws, "docs.mjs", () => `export function readDoc() { return null; }\n`),
      },
      {
        name: "the vulnerability is hidden by deleting the secret",
        expectCheck: "secret file was not moved",
        apply: async (ws) => {
          const fs = await import("fs/promises");
          const path = await import("path");
          await fs.rm(path.join(ws, "secret.txt"));
        },
      },
    ]);

  // ── auth: the boundary case is the whole bug ──────────────────────────────
  add("auth/token-expiry-bug",
    (ws) => put(ws, "auth.mjs", `export function verifyToken(t, now = Date.now()) {
  if (!t || typeof t.expiresAt !== "number") return { valid: false, reason: "malformed" };
  if (t.expiresAt <= now) return { valid: false, reason: "expired" };
  return { valid: true, subject: t.sub };
}
`),
    [
      {
        name: "off-by-one: a token expiring exactly now is still accepted",
        expectCheck: "expiring exactly now",
        apply: (ws) => patch(ws, "auth.mjs", (s) => s.replace("t.expiresAt <= now", "t.expiresAt < now")),
      },
      {
        name: "the expiry check is removed entirely",
        expectCheck: "expired token is rejected",
        apply: (ws) => put(ws, "auth.mjs", `export function verifyToken(t) {
  if (!t || typeof t.expiresAt !== "number") return { valid: false, reason: "malformed" };
  return { valid: true, subject: t.sub };
}
`),
      },
      {
        name: "everything is rejected, which technically rejects expired tokens",
        expectCheck: "valid token still verifies",
        apply: (ws) => put(ws, "auth.mjs", `export function verifyToken() { return { valid: false, reason: "expired" }; }\n`),
      },
    ]);

  // ── error handling: surfacing the error is not the same as explaining it ──
  add("error-handling/swallowed-errors",
    (ws) => put(ws, "client.mjs", `let transport = async () => { throw new Error("not configured"); };
export function setTransport(fn) { transport = fn; }
export async function fetchUser(id) {
  let res;
  try { res = await transport(\`/api/users/\${id}\`); }
  catch (cause) { throw new Error(\`fetchUser failed: \${cause.message}\`, { cause }); }
  if (res.status === 404) return null;
  return res.body;
}
`),
    [
      {
        name: "the error is still swallowed, just logged first",
        expectCheck: "distinguishable",
        apply: (ws) => put(ws, "client.mjs", `let transport = async () => { throw new Error("not configured"); };
export function setTransport(fn) { transport = fn; }
export async function fetchUser(id) {
  try {
    const res = await transport(\`/api/users/\${id}\`);
    if (res.status === 404) return null;
    return res.body;
  } catch (e) { console.error(e); return null; }
}
`),
      },
      {
        name: "it throws, but hides what actually went wrong",
        expectCheck: "underlying cause",
        apply: (ws) => patch(ws, "client.mjs", (s) =>
          s.replace(/catch \(cause\)[^\n]*\n/, `catch { throw new Error("request failed"); }\n`)),
      },
      {
        name: "a 404 now throws too, so callers still cannot tell them apart",
        expectCheck: "404 still means",
        apply: (ws) => patch(ws, "client.mjs", (s) =>
          s.replace("if (res.status === 404) return null;", `if (res.status === 404) throw new Error("not found");`)),
      },
    ]);

  // ── cli: printing an error is not reporting failure ───────────────────────
  add("cli/exit-codes",
    (ws) => put(ws, "cli.mjs", `const name = process.argv[2];
if (!name) { console.error("usage: greet <name>"); process.exit(1); }
console.log(\`hello, \${name}\`);
`),
    [
      {
        name: "prints an error but still exits 0",
        expectCheck: "exits non-zero",
        apply: (ws) => put(ws, "cli.mjs", `const name = process.argv[2];
if (!name) { console.error("usage: greet <name>"); } else { console.log(\`hello, \${name}\`); }
`),
      },
      {
        name: "exits non-zero on success too",
        expectCheck: "exits 0",
        apply: (ws) => patch(ws, "cli.mjs", (s) => `${s}\nprocess.exit(2);\n`),
      },
      {
        name: "the greeting output changed",
        expectCheck: "prints the greeting",
        apply: (ws) => patch(ws, "cli.mjs", (s) => s.replace("hello, ", "Hello ")),
      },
    ]);

  // ── database: idempotent must not mean destructive ────────────────────────
  add("database/idempotent-migration",
    (ws) => put(ws, "migrate.mjs", `export function migrate(db) {
  if (!db.hasTable("users")) db.createTable("users", ["id", "name"]);
  if (!db.hasColumn("users", "email")) db.addColumn("users", "email");
}
`),
    [
      {
        name: "made idempotent by dropping and recreating the table (loses rows)",
        expectCheck: "preserves existing rows",
        apply: (ws) => put(ws, "migrate.mjs", `export function migrate(db) {
  db.tables.delete("users");
  db.createTable("users", ["id", "name"]);
  db.addColumn("users", "email");
}
`),
      },
      {
        name: "errors swallowed with a bare try/catch instead of a real guard",
        expectCheck: "preserves existing rows",
        apply: (ws) => put(ws, "migrate.mjs", `export function migrate(db) {
  try { db.tables.delete("users"); db.createTable("users", ["id", "name"]); db.addColumn("users", "email"); } catch {}
}
`),
      },
      {
        name: "the migration became a no-op, so the schema is never created",
        expectCheck: "first run still creates the schema",
        apply: (ws) => put(ws, "migrate.mjs", `export function migrate() {}\n`),
      },
    ]);

  // ── dependency upgrade: output must not drift ─────────────────────────────
  add("dependencies/breaking-api-update",
    (ws) => put(ws, "report.mjs", `import { formatDate } from "./vendor/tiny-date/index.mjs";
export function buildReport(dates) {
  return dates.map((d) => formatDate(d, { pattern: "YYYY-MM-DD" })).join(", ");
}
`),
    [
      {
        name: "migrated, but the output format changed",
        expectCheck: "same output as before",
        apply: (ws) => patch(ws, "report.mjs", (s) => s.replace('"YYYY-MM-DD"', '"DD/MM/YYYY"')),
      },
      {
        name: "avoided the migration by vendoring a private copy of v1",
        expectCheck: "vendor a private copy",
        apply: (ws) => put(ws, "report.mjs", `function format(date, pattern) {
  const d = new Date(date); const pad = (n) => String(n).padStart(2, "0");
  return pattern.replace("YYYY", d.getUTCFullYear()).replace("MM", pad(d.getUTCMonth() + 1)).replace("DD", pad(d.getUTCDate()));
}
export function buildReport(dates) { return dates.map((d) => format(d, "YYYY-MM-DD")).join(", "); }
`),
      },
      {
        name: "the library was edited instead of the call site",
        expectCheck: "dependency itself was not edited",
        apply: async (ws) => {
          await patch(ws, "vendor/tiny-date/index.mjs", (s) => `${s}\nexport const format = (d, pattern) => formatDate(d, { pattern });\n`);
        },
      },
    ]);

  // ── navigation: the decoys must not be able to satisfy it ─────────────────
  add("navigation/needle-in-large-workspace",
    (ws) => patch(ws, "src/lib/internal/fmt/currency.mjs", (s) =>
      s.replace("  // BUG: the argument is ignored.\n  return SYMBOLS.USD;", "  return SYMBOLS[currency] ?? SYMBOLS.USD;")),
    [
      {
        name: "edited a decoy module instead of the live path",
        expectCheck: "renders with",
        // Reverts the real fix first: the point is "edited a decoy INSTEAD of
        // the live file", not "also touched a decoy".
        apply: async (ws) => {
          await patch(ws, "src/lib/internal/fmt/currency.mjs", (t) =>
            t.replace("return SYMBOLS[currency] ?? SYMBOLS.USD;", "return SYMBOLS.USD;"));
          await put(ws, "src/utils/currencyUtils.mjs",
            `export const CURRENCY_SYMBOLS = { USD: "$", EUR: "\u20ac", GBP: "\u00a3", JPY: "\u00a5" };
export function getSymbol(c) { return CURRENCY_SYMBOLS[c] ?? "$"; }
`);
        },
      },
      {
        name: "special-cased EUR and left the other currencies broken",
        expectCheck: "GBP renders",
        apply: (ws) => patch(ws, "src/lib/internal/fmt/currency.mjs", (s) =>
          s.replace("return SYMBOLS[currency] ?? SYMBOLS.USD;", 'return currency === "EUR" ? SYMBOLS.EUR : SYMBOLS.USD;')),
      },
      {
        name: "broke the currency that already worked",
        expectCheck: "USD still renders",
        apply: (ws) => patch(ws, "src/lib/internal/fmt/currency.mjs", (s) =>
          s.replace(/const SYMBOLS = \{[^}]*\};/, 'const SYMBOLS = { EUR: "\u20ac", GBP: "\u00a3", JPY: "\u00a5" };')),
      },
    ]);

  // ── nextjs: the boundary, not the build ───────────────────────────────────
  add("nextjs/server-client-boundary",
    async (ws) => {
      await put(ws, "app/products/ProductList.tsx", `"use client";
import { useState } from "react";

export function ProductList({ products }: { products: { id: string; title: string; price: number }[] }) {
  const [cart, setCart] = useState<string[]>([]);
  return (
    <ul>
      {products.map((p) => (
        <li key={p.id}>
          {p.title} — {p.price}
          <button onClick={() => setCart([...cart, p.id])}>Add to cart</button>
        </li>
      ))}
    </ul>
  );
}
`);
      await put(ws, "app/products/page.tsx", `import { getProducts } from "../../lib/db";
import { ProductList } from "./ProductList";

export default async function ProductsPage({ params }: { params: Promise<{ category: string }> }) {
  const { category } = await params;
  const products = await getProducts(category);
  return (
    <main>
      <h1>{category}</h1>
      <ProductList products={products} />
    </main>
  );
}
`);
    },
    [
      {
        name: 'the lazy "fix": mark the whole page "use client"',
        expectCheck: "still a Server Component",
        apply: (ws) => put(ws, "app/products/page.tsx", `"use client";
import { useState } from "react";
import { getProducts } from "../../lib/db";

export default function ProductsPage({ params }: { params: { category: string } }) {
  const [cart, setCart] = useState<string[]>([]);
  return <main><button onClick={() => setCart([...cart, "x"])}>Add to cart</button></main>;
}
`),
      },
      {
        name: "the interactivity was deleted rather than moved",
        expectCheck: "client component holds the cart",
        apply: async (ws) => {
          const fs = await import("fs/promises");
          const path = await import("path");
          await fs.rm(path.join(ws, "app/products/ProductList.tsx"));
          await put(ws, "app/products/page.tsx", `import { getProducts } from "../../lib/db";
export default async function ProductsPage({ params }: { params: Promise<{ category: string }> }) {
  const { category } = await params;
  const products = await getProducts(category);
  return <main><ul>{products.map((p) => <li key={p.id}>{p.title}</li>)}</ul></main>;
}
`);
        },
      },
      {
        name: "server-only db import dragged into the client component",
        expectCheck: "server-only module is not imported by client",
        apply: (ws) => patch(ws, "app/products/ProductList.tsx", (s) =>
          s.replace('import { useState } from "react";', 'import { useState } from "react";\nimport { getProducts } from "../../lib/db";')),
      },
      {
        name: "params still read synchronously (Next 15 makes it a Promise)",
        expectCheck: "params is awaited",
        apply: (ws) => patch(ws, "app/products/page.tsx", (s) =>
          s.replace("{ params }: { params: Promise<{ category: string }> }", "{ params }: { params: { category: string } }")
           .replace("const { category } = await params;", "const category = params.category;")),
      },
    ]);

  // ── tests: an empty suite is the classic silent pass ──────────────────────
  add("tests/add-missing-unit-tests",
    (ws) => put(ws, "slugify.test.mjs", `import test from "node:test";
import assert from "node:assert";
import { slugify } from "./slugify.mjs";

test("collapses spaces", () => { assert.strictEqual(slugify("Hello World"), "hello-world"); });
test("lowercases uppercase input", () => { assert.strictEqual(slugify("LOUD Title"), "loud-title"); });
test("collapses repeated separators", () => { assert.strictEqual(slugify("a---b"), "a-b"); });
`),
    [
      {
        name: "tests that assert nothing but still exit 0",
        expectCheck: "assert something",
        apply: (ws) => put(ws, "slugify.test.mjs", `import test from "node:test";
import { slugify } from "./slugify.mjs";
test("a", () => { slugify("x"); });
test("b", () => { slugify("y"); });
test("c", () => { slugify("z"); });
`),
      },
      {
        name: "green achieved by skipping the cases",
        expectCheck: "skip or todo",
        apply: (ws) => patch(ws, "slugify.test.mjs", (s) => s.replace(/\btest\(/g, "test.skip(")),
      },
      {
        name: "the module under test was changed to fit the tests",
        expectCheck: "slugify.mjs itself was not changed",
        apply: (ws) => patch(ws, "slugify.mjs", (s) => `${s}\nexport const _touched = true;\n`),
      },
    ]);

  // ── backend wiring: behaviour right, integration wrong ────────────────────
  add("backend/health-route-wiring",
    (ws) => patch(ws, "server.mjs", (s) => s.replace(
      `  "GET /api/ping": () => ({ status: 200, body: { pong: true } }),`,
      `  "GET /api/ping": () => ({ status: 200, body: { pong: true } }),\n  "GET /api/health": () => ({ status: 200, body: { status: "ok" } }),`)),
    [
      {
        name: "endpoint bolted on beside the route table instead of into it",
        expectCheck: "wired into the existing route table",
        apply: (ws) => put(ws, "server.mjs", `import http from "http";
export const routes = { "GET /api/ping": () => ({ status: 200, body: { pong: true } }) };
export function handle(method, url) {
  if (method === "GET" && url === "/api/health") return { status: 200, body: { status: "ok" } };
  const h = routes[\`\${method} \${url}\`];
  if (!h) return { status: 404, body: { error: "not found" } };
  return h();
}
`),
      },
      {
        name: "wrong response body",
        expectCheck: 'body is {"status":"ok"}',
        apply: (ws) => patch(ws, "server.mjs", (s) => s.replace('body: { status: "ok" }', 'body: { ok: true }')),
      },
      {
        name: "the pre-existing route was broken while adding the new one",
        expectCheck: "/api/ping route still works",
        apply: (ws) => patch(ws, "server.mjs", (s) => s.replace(
          `  "GET /api/ping": () => ({ status: 200, body: { pong: true } }),\n`, "")),
      },
      {
        name: "the 404 fallback was lost",
        expectCheck: "unknown routes still 404",
        apply: (ws) => patch(ws, "server.mjs", (s) => s.replace(
          `  if (!handler) return { status: 404, body: { error: "not found" } };`,
          `  if (!handler) return { status: 200, body: {} };`)),
      },
    ]);

  // ── the resume case, which started this whole line of work ────────────────
  add("react/command-palette-resume",
    async (ws) => {
      await put(ws, "src/components/CommandPalette.tsx", `import { useState } from "react";
import { listCommands } from "../commands";

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const commands = listCommands().filter((c) => c.title.toLowerCase().includes(query.toLowerCase()));
  if (!open) return null;
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "Enter") { commands[selected]?.run(); onClose(); }
  }
  return (
    <div className="palette" onKeyDown={onKeyDown}>
      <input value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul>{commands.map((c, i) => (<li key={c.id} className={i === selected ? "selected" : ""}>{c.title}</li>))}</ul>
    </div>
  );
}
`);
      await patch(ws, "src/commands.mjs", (s) => `${s.replace(/\/\/ TODO.*\n?/, "")}
registerCommand({ id: "reload", title: "Reload window", run: () => {} });
`);
      await put(ws, "src/App.tsx", `import { useState } from "react";
import { CommandPalette } from "./components/CommandPalette";

export function App() {
  const [count, setCount] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  return (
    <main>
      <button onClick={() => setCount(count + 1)}>count is {count}</button>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </main>
  );
}
`);
    },
    [
      {
        name: "wired into the app but the component itself never finished",
        expectCheck: "half-built component itself was actually changed",
        apply: async (ws) => {
          const fs = await import("fs/promises");
          const path = await import("path");
          const fixture = path.join(
            new URL("../../../benchmarks/react/command-palette-resume/workspace/", import.meta.url).pathname,
            "src/components/CommandPalette.tsx");
          await fs.copyFile(fixture, path.join(ws, "src/components/CommandPalette.tsx"));
        },
      },
      {
        name: "Escape handling dropped",
        expectCheck: "closes on Escape",
        apply: (ws) => patch(ws, "src/components/CommandPalette.tsx", (s) =>
          s.replace('if (e.key === "Escape") { onClose(); return; }', "")),
      },
      {
        name: "Enter runs the FIRST command instead of the selected one",
        expectCheck: "SELECTED command",
        apply: (ws) => patch(ws, "src/components/CommandPalette.tsx", (s) =>
          s.replace("commands[selected]?.run();", "commands[0]?.run();")),
      },
      {
        name: "finished but never rendered from the app",
        expectCheck: "renders CommandPalette",
        apply: (ws) => put(ws, "src/App.tsx", `import { useState } from "react";
export function App() {
  const [count, setCount] = useState(0);
  return <main><button onClick={() => setCount(count + 1)}>count is {count}</button></main>;
}
`),
      },
    ]);

  return specs;
}
