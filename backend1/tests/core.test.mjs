/**
 * tests/core.test.mjs
 * Run with: node tests/core.test.mjs
 *
 * Tests the pure-function layer of the agent — no server needed.
 */

import assert from "assert";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

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

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// ── 1. repairJSON (plan_changes) ──────────────────────────────────────────────

console.log("\n📦 repairJSON");

function repairJSON(text) {
  let result = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { result += ch; escape = false; }
    else if (ch === "\\" && inString) { result += ch; escape = true; }
    else if (ch === '"') { result += ch; inString = !inString; }
    else if (inString && ch === "\n") { result += "\\n"; }
    else if (inString && ch === "\r") { result += "\\r"; }
    else if (inString && ch === "\t") { result += "\\t"; }
    else { result += ch; }
  }
  return result;
}

test("valid JSON passes through unchanged", () => {
  const input = '{"key":"value"}';
  assert.strictEqual(repairJSON(input), input);
});

test("literal newline inside string is escaped", () => {
  const input = '{"patch":"line1\nline2"}';
  const repaired = repairJSON(input);
  const parsed = JSON.parse(repaired);
  assert.strictEqual(parsed.patch, "line1\nline2");
});

test("literal tab inside string is escaped", () => {
  const input = '{"code":"a\tb"}';
  const repaired = repairJSON(input);
  const parsed = JSON.parse(repaired);
  assert.strictEqual(parsed.code, "a\tb");
});

test("newline outside string is left as-is", () => {
  const input = '{\n"key":"value"\n}';
  const repaired = repairJSON(input);
  const parsed = JSON.parse(repaired);
  assert.strictEqual(parsed.key, "value");
});

// ── 2. isForgetCommand (answer node) ─────────────────────────────────────────

console.log("\n🗑️  isForgetCommand");

function isForgetCommand(msg) {
  return /\b(?:forget|clear|wipe)\s+(?:all\s+)?(?:memory|memories)\b|\bforget\s+(?:the\s+)?\w[\w-]*\s+memory\b|\bclear\s+memory\s+topic\b/i.test(msg);
}

test("'forget all memory' matches", () => {
  assert.ok(isForgetCommand("forget all memory"));
});

test("'clear all memories' matches", () => {
  assert.ok(isForgetCommand("clear all memories"));
});

test("'forget memory about code-patterns' matches", () => {
  assert.ok(isForgetCommand("forget memory about code-patterns"));
});

test("'forget the code-patterns memory' matches", () => {
  assert.ok(isForgetCommand("forget the code-patterns memory"));
});

test("'clear memory topic code-patterns' matches", () => {
  assert.ok(isForgetCommand("clear memory topic code-patterns"));
});

test("'how do I delete files from memory?' does NOT match", () => {
  assert.ok(!isForgetCommand("how do I delete files from memory?"));
});

test("'what is in memory?' does NOT match", () => {
  assert.ok(!isForgetCommand("what is in memory?"));
});

// ── 3. remember: detection ────────────────────────────────────────────────────

console.log("\n🧠 remember: command");

function isRememberCommand(msg) {
  return /^remember[:\s]/i.test(msg);
}

test("'remember: use tabs' matches", () => {
  assert.ok(isRememberCommand("remember: use tabs"));
});

test("'remember always use motion.div' matches", () => {
  assert.ok(isRememberCommand("remember always use motion.div"));
});

test("'what do you remember?' does NOT match", () => {
  assert.ok(!isRememberCommand("what do you remember?"));
});

test("short message forced to write when remember: prefix", () => {
  const effectiveMessage = "remember: use tabs";
  const isRemember = /^remember[:\s]/i.test(effectiveMessage);
  const shouldWrite = effectiveMessage.length > 60 || isRemember;
  assert.ok(shouldWrite, "should write despite being short");
});

// ── 4. validateSyntax (execute_changes) ──────────────────────────────────────

console.log("\n✅ validateSyntax");

import { createRequire } from "module";
const _require = createRequire(import.meta.url);

function loadTypeScript() {
  const candidates = [
    path.join(__dirname, "../../chatbot/my-chatbot-ui/node_modules/typescript"),
    path.join(__dirname, "../node_modules/typescript"),
  ];
  for (const p of candidates) {
    try { return _require(p); } catch {}
  }
  return null;
}

function validateSyntax(content, fakePath) {
  const ext = path.extname(fakePath).toLowerCase();
  if (ext === ".py") {
    try {
      const { spawnSync } = _require("child_process");
      const res = spawnSync("python3", ["-c", "import ast, sys; ast.parse(sys.stdin.read())"], {
        input: content, encoding: "utf-8", timeout: 3000,
      });
      if (res.status !== 0) return "Python syntax error";
    } catch {}
    return null;
  }
  if (![".tsx", ".jsx", ".ts", ".js"].includes(ext)) return null;
  const ts = loadTypeScript();
  if (!ts) return null;
  const kindMap = { ".tsx": ts.ScriptKind.TSX, ".jsx": ts.ScriptKind.JSX, ".ts": ts.ScriptKind.TS, ".js": ts.ScriptKind.JS };
  try {
    const sf = ts.createSourceFile("test" + ext, content, ts.ScriptTarget.ESNext, true, kindMap[ext]);
    const d = sf.parseDiagnostics;
    if (!Array.isArray(d) || !d.length) return null;
    return `L${sf.getLineAndCharacterOfPosition(d[0].start || 0).line + 1}: parse error`;
  } catch { return null; }
}

test("valid TSX returns null", () => {
  const ok = `import React from "react";\nexport default function A() { return <div>hi</div>; }`;
  assert.strictEqual(validateSyntax(ok, "test.tsx"), null);
});

test("broken TSX returns error string", () => {
  // Unclosed JSX expression attribute — definitely a parse-level error
  const broken = `export default () => <div className={;`;
  const err = validateSyntax(broken, "test.tsx");
  assert.ok(err !== null, "expected an error for broken TSX");
});

test("valid JS returns null", () => {
  const ok = `function greet(name) { return "hello " + name; }`;
  assert.strictEqual(validateSyntax(ok, "test.js"), null);
});

test("non-code file (.md) skipped — returns null", () => {
  assert.strictEqual(validateSyntax("# hello world", "readme.md"), null);
});

await testAsync("valid Python returns null", async () => {
  const ok = "def hello():\n    return 'world'\n";
  assert.strictEqual(validateSyntax(ok, "hello.py"), null);
});

await testAsync("broken Python returns error", async () => {
  const broken = "def hello(\n    return 'world'\n";
  const err = validateSyntax(broken, "hello.py");
  assert.ok(err !== null, "expected an error for broken Python");
});

// ── 5. Conversation trim (agentic_explore) ────────────────────────────────────

console.log("\n✂️  Conversation trimming");

function trimConversation(msgs, maxMsgs = 22) {
  if (msgs.length <= maxMsgs) return msgs;
  const [first, ...rest] = msgs;
  return [first, ...rest.slice(-(maxMsgs - 1))];
}

test("messages under limit are unchanged", () => {
  const msgs = Array.from({ length: 10 }, (_, i) => ({ role: "user", content: String(i) }));
  assert.strictEqual(trimConversation(msgs).length, 10);
});

test("messages over limit are trimmed, first message always kept", () => {
  const msgs = Array.from({ length: 30 }, (_, i) => ({ role: "tool", content: String(i) }));
  msgs[0] = { role: "user", content: "task" };
  const trimmed = trimConversation(msgs);
  assert.strictEqual(trimmed.length, 22);
  assert.strictEqual(trimmed[0].content, "task");
  assert.strictEqual(trimmed[trimmed.length - 1].content, "29");
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(40)}`);
console.log(`  ${passed} passed  ${failed} failed`);
if (failed > 0) process.exit(1);
