/**
 * tests/promptGating.test.mjs
 * Run with: node tests/promptGating.test.mjs
 *
 * The three observed behaviours, fixed in their real subsystems:
 *
 *   1. session/memory separation — an answer given in THIS session suppresses a
 *      repeat question; memory recall alone never does.
 *   2. multi-field questioning   — each field is its own independently
 *      correlated ask_user interaction.
 *   3. confirmation gating       — irreversible/production commands cannot run
 *      without an explicit yes.
 *
 * Everything runs through the REAL executeTool path, so a passing test means
 * the runtime is gated, not just a helper.
 */

import assert from "assert";
import path from "path";
import fs from "fs/promises";
import os from "os";

import {
  executeTool, isIrreversibleCommand, bashApprovalNeeded,
} from "../agents/nodes/agent_loop.mjs";
import {
  normalizeQuestion, listAnsweredQuestions, clearSessionAnswers, _resetSessionAnswers,
} from "../services/sessionAnswers.mjs";
import { normalizeHookConfig, fireHookEvent } from "../services/hooks.mjs";

let passed = 0;
let failed = 0;

async function test(name, fn) {
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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-gating-"));
const cfg = (raw) => normalizeHookConfig(raw).hooks;

function ctxFor({ sessionId = "sess-1", permissions = { allow: [], ask: [], deny: [] }, askUser = null, hooks = {} } = {}) {
  const config = cfg(hooks);
  const fired = [];
  return {
    ctx: {
      root: tmp, emit: null, sessionId, requestId: "req-1",
      hooks: {}, permissions, editedFiles: new Map(), readFiles: new Set(),
      todosRef: { current: [] }, workspaceSnapshot: [], permissionMode: "auto",
      mcpClients: new Map(), mcpRoutes: new Map(), bashCommands: [], askUser,
      fireHook: async (event, payload, opts = {}) => {
        fired.push({ event, payload });
        return fireHookEvent(event, payload, { config, cwd: tmp, ...opts });
      },
    },
    fired,
  };
}

// ── 1. session / memory separation ───────────────────────────────────────────

console.log("\n📦 1. active-session answers vs memory");

await test("a question answered in this session is NOT asked again", async () => {
  _resetSessionAnswers();
  let asks = 0;
  const { ctx } = ctxFor({ sessionId: "s1", askUser: async () => { asks++; return "staging"; } });

  const a = await executeTool("ask_user", { question: "Deploy to staging or production?" }, ctx);
  const b = await executeTool("ask_user", { question: "Deploy to staging or production?" }, ctx);

  assert.strictEqual(asks, 1, `the user must be asked once, was asked ${asks}×`);
  assert.strictEqual(a.answer, "staging");
  assert.strictEqual(b.answer, "staging", "the second call must reuse the real answer");
  assert.strictEqual(b.reused, true);
});

await test("cosmetic rewording of the same question still reuses the answer", async () => {
  _resetSessionAnswers();
  let asks = 0;
  const { ctx } = ctxFor({ sessionId: "s2", askUser: async () => { asks++; return "production"; } });
  await executeTool("ask_user", { question: "Deploy to staging or production?" }, ctx);
  await executeTool("ask_user", { question: "  deploy to staging or PRODUCTION  " }, ctx);
  assert.strictEqual(asks, 1);
});

await test("a DIFFERENT question is still asked (no over-matching)", async () => {
  _resetSessionAnswers();
  const seen = [];
  const { ctx } = ctxFor({ sessionId: "s3", askUser: async ({ question }) => { seen.push(question); return "x"; } });
  await executeTool("ask_user", { question: "Which environment?" }, ctx);
  await executeTool("ask_user", { question: "Which branch?" }, ctx);
  assert.strictEqual(seen.length, 2, "distinct questions must each be asked");
});

await test("a DIFFERENT session does not inherit the answer", async () => {
  _resetSessionAnswers();
  let asks = 0;
  const ask = async () => { asks++; return "staging"; };
  await executeTool("ask_user", { question: "Which environment?" }, ctxFor({ sessionId: "old", askUser: ask }).ctx);
  await executeTool("ask_user", { question: "Which environment?" }, ctxFor({ sessionId: "new", askUser: ask }).ctx);
  assert.strictEqual(asks, 2, "a new session must ask again — a stale answer must never auto-apply");
});

await test("a CANCELLED question records nothing, so it is genuinely re-asked", async () => {
  _resetSessionAnswers();
  let asks = 0;
  const { ctx } = ctxFor({
    sessionId: "s4",
    askUser: async () => { asks++; if (asks === 1) throw new Error("cancelled"); return "staging"; },
  });
  const first = await executeTool("ask_user", { question: "Which environment?" }, ctx);
  assert.strictEqual(first.success, false);
  const second = await executeTool("ask_user", { question: "Which environment?" }, ctx);
  assert.strictEqual(second.answer, "staging");
  assert.strictEqual(asks, 2, "a cancellation is not an answer");
});

await test("answers are session state, and ending a session clears them", async () => {
  _resetSessionAnswers();
  const { ctx } = ctxFor({ sessionId: "s5", askUser: async () => "eu-west-1" });
  await executeTool("ask_user", { question: "Which region?" }, ctx);
  assert.strictEqual(listAnsweredQuestions("s5").length, 1, "retained for audit while active");
  clearSessionAnswers("s5");
  assert.strictEqual(listAnsweredQuestions("s5").length, 0, "cleared when the session ends");
});

await test("normalizeQuestion is conservative — it never fuzzy-matches", () => {
  assert.strictEqual(normalizeQuestion("Deploy to prod?"), normalizeQuestion("  deploy to PROD  "));
  assert.notStrictEqual(normalizeQuestion("Which environment?"), normalizeQuestion("Which region?"));
  assert.notStrictEqual(normalizeQuestion("Deploy to prod?"), normalizeQuestion("Deploy to staging?"));
});

// ── 2. multi-field questioning ───────────────────────────────────────────────

console.log("\n📦 2. multi-field questioning");

await test("three fields produce three separate, ordered, correlated asks", async () => {
  _resetSessionAnswers();
  const asked = [];
  const answers = { "Which target environment?": "production", "Which deployment branch?": "main", "Which deployment region?": "eu-west-1" };
  const { ctx } = ctxFor({ sessionId: "multi", askUser: async ({ question }) => { asked.push(question); return answers[question]; } });

  const results = [];
  for (const q of Object.keys(answers)) {
    results.push(await executeTool("ask_user", { question: q }, ctx));
  }

  assert.deepStrictEqual(asked, Object.keys(answers), "each field asked separately, in order");
  assert.deepStrictEqual(results.map((r) => r.answer), ["production", "main", "eu-west-1"],
    "each answer must correlate to its own question");
  assert.strictEqual(listAnsweredQuestions("multi").length, 3, "all three tracked independently");
});

await test("re-asking any one field within the session reuses only THAT answer", async () => {
  _resetSessionAnswers();
  let asks = 0;
  const { ctx } = ctxFor({ sessionId: "multi2", askUser: async ({ question }) => { asks++; return question.includes("branch") ? "main" : "production"; } });
  await executeTool("ask_user", { question: "Which target environment?" }, ctx);
  await executeTool("ask_user", { question: "Which deployment branch?" }, ctx);
  const again = await executeTool("ask_user", { question: "Which deployment branch?" }, ctx);
  assert.strictEqual(asks, 2, "only the two distinct fields are asked");
  assert.strictEqual(again.answer, "main", "the reused answer is the branch answer, not the environment one");
});

await test("the system prompt tells the model to ask per field when explicitly requested", async () => {
  const src = await fs.readFile(new URL("../agents/nodes/agent_loop.mjs", import.meta.url), "utf-8");
  assert.ok(/one ask_user call per field/.test(src), "the per-field instruction must be present");
  assert.ok(/prompting IS the task/.test(src), "must forbid answering with a plan instead of asking");
  assert.ok(/On your own initiative keep it to at most one or two questions/.test(src),
    "the self-initiated limit must still apply so the agent doesn't interrogate users");
});

// ── 3. confirmation / irreversible gating ────────────────────────────────────

console.log("\n📦 3. irreversible + production gating");

await test("production-affecting commands are detected", () => {
  const perms = { allow: [], ask: [], deny: [] };
  for (const cmd of [
    "git push --force origin main", "git push origin main",
    "vercel deploy --prod", "kubectl apply -f k8s/", "terraform apply",
    "helm upgrade api ./chart", "npm publish", "docker push acme/api:latest",
    "aws s3 rm s3://bucket --recursive",
  ]) {
    assert.ok(isIrreversibleCommand(cmd, perms), `should be gated: ${cmd}`);
  }
});

await test("ordinary commands are NOT gated (no over-blocking)", () => {
  const perms = { allow: [], ask: [], deny: [] };
  for (const cmd of ["npm test", "git status", "ls -la", "git push origin feature/x", "npm run build", "grep -r foo ."]) {
    assert.ok(!isIrreversibleCommand(cmd, perms), `should NOT be gated: ${cmd}`);
  }
});

await test("an irreversible command does NOT run without approval", async () => {
  const { ctx } = ctxFor({ askUser: async () => "Deny" });
  const r = await executeTool("bash", { command: "npm publish" }, ctx);
  assert.strictEqual(r.success, false);
  assert.ok(/not approved/i.test(r.error), r.error);
  assert.strictEqual(ctx.bashCommands.length, 0, "the command must never have been executed");
});

await test("it runs once the user explicitly approves", async () => {
  const { ctx } = ctxFor({ askUser: async () => "Allow" });
  await executeTool("bash", { command: "git push --force origin main" }, ctx);
  assert.strictEqual(ctx.bashCommands.length, 1, "approval must let it through");
});

await test("approval is never INFERRED — no askUser means no execution", async () => {
  const { ctx } = ctxFor({ askUser: null });
  // npm is allow-listed, so this reaches the confirmation gate rather than
  // being rejected earlier by the binary allowlist.
  const r = await executeTool("bash", { command: "npm publish" }, ctx);
  assert.strictEqual(r.success, false);
  assert.ok(/requires approval/i.test(r.error), r.error);
  assert.strictEqual(ctx.bashCommands.length, 0);
});

await test("the confirmation question names the actual command and is not broadened", async () => {
  let seen = null;
  const { ctx } = ctxFor({ askUser: async (q) => { seen = q; return "Allow"; } });
  await executeTool("bash", { command: "npm publish" }, ctx);
  assert.ok(/npm publish/.test(seen.question), "must quote the exact command");
  assert.ok(/irreversible or affects production/.test(seen.question));
  assert.strictEqual(seen.options.length, 2, "a confirmation is binary — not an open question");
});

await test("PermissionRequest fires for the gate and PermissionDenied on refusal", async () => {
  const { ctx, fired } = ctxFor({ askUser: async () => "Deny" });
  await executeTool("bash", { command: "npm publish" }, ctx);
  assert.ok(fired.some((e) => e.event === "PermissionRequest"), "must use the existing permission path");
  assert.ok(fired.some((e) => e.event === "PermissionDenied"), "denial must be observable");
  const req = fired.find((e) => e.event === "PermissionRequest");
  assert.strictEqual(req.payload.kind, "irreversible");
});

await test("an explicit deny rule still wins and never prompts", async () => {
  let asked = false;
  const { ctx } = ctxFor({
    permissions: { allow: [], ask: [], deny: ["Bash(npm publish:*)"] },
    askUser: async () => { asked = true; return "Allow"; },
  });
  const r = await executeTool("bash", { command: "npm publish" }, ctx);
  assert.strictEqual(r.success, false);
  assert.strictEqual(asked, false, "a denied command must not even be offered for approval");
});

await test("an explicit allow rule opts out of the safety floor", async () => {
  let asked = false;
  const perms = { allow: ["Bash(npm publish:*)"], ask: [], deny: [] };
  assert.strictEqual(isIrreversibleCommand("npm publish", perms), false, "an explicit allow is a recorded decision");
  const { ctx } = ctxFor({ permissions: perms, askUser: async () => { asked = true; return "Allow"; } });
  await executeTool("bash", { command: "npm publish" }, ctx);
  assert.strictEqual(asked, false, "an allow-listed command must not re-prompt every time");
});

await test("gating adds to, and never replaces, workspace ask rules", async () => {
  assert.strictEqual(bashApprovalNeeded("git push origin main", { allow: [], ask: ["Bash(git push:*)"] }), true);
  // Both reasons can apply at once; the command is still gated exactly once.
  let asks = 0;
  const { ctx } = ctxFor({ permissions: { allow: [], ask: ["Bash(git push:*)"], deny: [] }, askUser: async () => { asks++; return "Allow"; } });
  await executeTool("bash", { command: "git push origin main" }, ctx);
  assert.strictEqual(asks, 1, "must prompt once, not twice");
});

await test("a blocked/denied command still returns a provider-valid result envelope", async () => {
  const { ctx } = ctxFor({ askUser: async () => "Deny" });
  const r = await executeTool("bash", { command: "npm publish" }, ctx);
  assert.strictEqual(typeof r, "object");
  assert.strictEqual(r.success, false);
  assert.strictEqual(typeof r.error, "string", "a denial must be a normal tool result, not a throw");
});

await fs.rm(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
