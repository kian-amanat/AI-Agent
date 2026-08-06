/**
 * tests/subagentLiveE2E.test.mjs
 *
 *   npm run test:subagent-e2e   → runs for real; FAILS loudly with no credential
 *   npm test                    → KODO_E2E_OPTIONAL=1, so it SKIPS instead
 *
 * Phase 3: prove a REAL model drives the subagent system.
 *
 *   Scenario A — the model delegates research to a subagent and grounds its
 *                answer in the subagent's report.
 *   Scenario B — the model uses a write-capable ISOLATED subagent, then reviews
 *                and applies the resulting patch. The workspace must change
 *                only after the model calls review_patch approve.
 *   Scenario C — the model uses a skill-guided subagent and its behaviour
 *                reflects the skill.
 *
 * Nothing is mocked and the test never calls subagent internals: the model
 * chooses spawn_agent / review_patch through the normal tool loop.
 *
 * Credentials come from the environment only (see mcpLiveE2E for the shared
 * provider convention).
 */

import assert from "assert";
import crypto from "crypto";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { execFile } from "child_process";

const RAW_KEY = process.env.KODO_E2E_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || "";
const API_KEY = RAW_KEY === "dummy" ? "" : RAW_KEY;
const OPTIONAL = process.env.KODO_E2E_OPTIONAL === "1";

const EXPLICIT_PROVIDER = (process.env.KODO_E2E_PROVIDER || "").trim().toLowerCase();
const IS_ANTHROPIC = EXPLICIT_PROVIDER === "anthropic"
  || (!EXPLICIT_PROVIDER && !process.env.KODO_E2E_BASE_URL && /^sk-ant-/.test(API_KEY));
const BASE_URL = (process.env.KODO_E2E_BASE_URL
  || (IS_ANTHROPIC ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1")).replace(/\/$/, "");
const MODEL = process.env.KODO_E2E_MODEL || (IS_ANTHROPIC ? "claude-sonnet-5" : "gpt-4o-mini");

const HOWTO = [
  "  Supply credentials via the environment (never hardcoded):",
  "",
  "    KODO_E2E_PROVIDER=openai-compatible \\",
  '    KODO_E2E_API_KEY="$YOUR_KEY" \\',
  '    KODO_E2E_BASE_URL="https://api.gapgpt.app/v1" \\',
  '    KODO_E2E_MODEL="gapgpt-qwen-3.6" \\',
  "    npm run test:subagent-e2e",
].join("\n");

if (!API_KEY) {
  if (OPTIONAL) {
    console.log("\n⏭  SKIPPED — LIVE SUBAGENT E2E did not run (no credential).");
    console.log("   NOT a verification: real-model subagent selection, worktree review/apply");
    console.log("   and skill-guided behaviour all remain unproven.\n");
    console.log(HOWTO + "\n");
    process.exit(0);
  }
  console.error("\n❌ LIVE SUBAGENT E2E CANNOT RUN — no API credential found.\n");
  console.error(HOWTO + "\n");
  process.exit(1);
}

// config/openai.mjs builds a client at import time; satisfy it before importing.
if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = API_KEY;

const { agentLoopNode } = await import("../agents/nodes/agent_loop.mjs");
const { getPatch, listPatches, _resetPatches } = await import("../services/worktreePatch.mjs");
const { activeWorktrees, removeAllWorktrees } = await import("../services/worktreeManager.mjs");
const { shutdownBackgroundSubagents } = await import("../services/backgroundSubagents.mjs");
const db = await import("../db.mjs");
const { buildConversationFromEvents } = await import("../services/conversationStore.mjs");

const sh = (a, cwd) => new Promise((r) => execFile(a[0], a.slice(1), { cwd }, (e, o) => r(String(o || ""))));

let passed = 0;
let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `\n      ${detail}`}`);
  ok ? passed++ : failed++;
};

async function makeRepo(files, agents = {}, skills = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-e2e-sub-"));
  await sh(["git", "init", "-q"], dir);
  await sh(["git", "config", "user.email", "t@e.com"], dir);
  await sh(["git", "config", "user.name", "T"], dir);
  for (const [f, c] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, f)), { recursive: true });
    await fs.writeFile(path.join(dir, f), c);
  }
  for (const [f, c] of Object.entries(agents)) {
    await fs.mkdir(path.join(dir, ".kodo", "agents"), { recursive: true });
    await fs.writeFile(path.join(dir, ".kodo", "agents", f), c);
  }
  for (const [f, c] of Object.entries(skills)) {
    await fs.mkdir(path.join(dir, ".kodo", "skills"), { recursive: true });
    await fs.writeFile(path.join(dir, ".kodo", "skills", f), c);
  }
  await sh(["git", "add", "."], dir);
  await sh(["git", "commit", "-qm", "init"], dir);
  return dir;
}

/** Drive the REAL agent loop with the REAL model. */
async function runAgent(workspace, userMessage, sessionId) {
  const events = [];
  db.createSession(sessionId, null, "e2e");
  db.clearTurnEvents(sessionId, null);
  const out = await agentLoopNode({
    workspacePath: workspace,
    userMessage,
    modelRoute: { ok: true, apiKey: API_KEY, model: MODEL, baseUrl: BASE_URL },
    visionRoute: {},
    sessionId, requestId: `req_${sessionId}`,
    permissionMode: "auto",
    emit: (e) => { if (e?.type === "progress") events.push(String(e.message || "")); },
    recordEvent: (ev) => { try { db.appendTurnEvent({ ...ev, sessionId, userId: null, requestId: `req_${sessionId}` }); } catch {} },
  });
  return { out, events, turnEvents: db.getTurnEvents(sessionId, null) };
}

const toolsCalled = (turnEvents) => turnEvents
  .filter((e) => e.kind === "assistant" && e.tool_calls)
  .flatMap((e) => { try { return JSON.parse(e.tool_calls) || []; } catch { return []; } })
  .map((c) => c.function?.name);

console.log("\nLIVE SUBAGENT E2E");
console.log(`Provider: ${EXPLICIT_PROVIDER || (IS_ANTHROPIC ? "anthropic" : "openai")}`);
console.log(`Model:    ${MODEL}`);
console.log(`Base URL: ${BASE_URL}\n`);

// ── Scenario A — delegation to a subagent ───────────────────────────────────
console.log("Scenario A — explorer delegation");
{
  const SECRET = `marker_${crypto.randomBytes(6).toString("hex")}`;
  const repo = await makeRepo({
    "src/config.js": `// deployment configuration\nexport const DEPLOY_TOKEN = "${SECRET}";\n`,
    "README.md": "# Project\n",
  });
  try {
    const { out, turnEvents } = await runAgent(repo,
      "Use the spawn_agent tool to delegate a search of this repository to a subagent, and report the exact value of DEPLOY_TOKEN in src/config.js. Do not read the file yourself — delegate it.",
      `sess_a_${Date.now()}`);

    const called = toolsCalled(turnEvents);
    check("the model called spawn_agent", called.includes("spawn_agent"), `called: ${called.join(", ") || "(none)"}`);
    check("the final answer is grounded in the subagent's findings",
      String(out.finalAnswer || "").includes(SECRET),
      `answer: ${String(out.finalAnswer || "").slice(0, 200)}`);

    const replayed = buildConversationFromEvents(turnEvents);
    const ids = new Set(replayed.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
    check("conversation stays provider-valid (no dangling tool_call)",
      replayed.every((m) => (m.tool_calls || []).every((tc) => ids.has(tc.id))));
  } finally { await fs.rm(repo, { recursive: true, force: true }); }
}

// ── Scenario B — worktree fixer + review/apply ──────────────────────────────
console.log("\nScenario B — isolated fixer, review and apply");
{
  _resetPatches();
  const repo = await makeRepo(
    { "math.js": "export function add(a, b) {\n  return a - b; // BUG: should be +\n}\n" },
    {
      "fixer.md": `---
name: fixer
description: Fixes a small bug in an isolated worktree
writeCapable: true
permissionMode: auto
isolation: worktree
tools: [read_file, edit_file, grep, glob, list_files]
---
You fix the specific bug you are told about. Make the minimal edit, then report what you changed.`,
    });
  const before = await fs.readFile(path.join(repo, "math.js"), "utf-8");
  try {
    const { out, turnEvents } = await runAgent(repo,
      "The add() function in math.js subtracts instead of adds. Use spawn_agent with agent_type 'fixer' to fix it in isolation. Then review the resulting patch with review_patch and, if it is correct, approve it.",
      `sess_b_${Date.now()}`);

    const called = toolsCalled(turnEvents);
    check("the model chose the isolated fixer agent", called.includes("spawn_agent"), `called: ${called.join(", ") || "(none)"}`);
    check("the model used review_patch", called.includes("review_patch"), `called: ${called.join(", ") || "(none)"}`);

    const patches = listPatches();
    check("a real patch was produced from the worktree", patches.length > 0,
      "no patch captured — the subagent may not have edited anything");
    if (patches.length) {
      const p = getPatch(patches[0].patchId);
      check("the patch summary names the changed file", p.summary.files.some((f) => /math\.js/.test(f.path)));
      check("the patch was decided (applied or rejected), not left dangling", p.status !== "pending", `status: ${p.status}`);
    }

    const after = await fs.readFile(path.join(repo, "math.js"), "utf-8");
    const applied = patches.length && getPatch(patches[0].patchId).status === "applied";
    check(applied ? "workspace changed ONLY after approval" : "workspace unchanged because the patch was not approved",
      applied ? after !== before && /a \+ b/.test(after) : after === before,
      `after: ${after.slice(0, 120)}`);

    check("no worktree leaked", activeWorktrees().length === 0, `${activeWorktrees().length} left`);
  } finally { await fs.rm(repo, { recursive: true, force: true }); }
}

// ── Scenario C — skill-guided subagent ──────────────────────────────────────
console.log("\nScenario C — skill-guided subagent");
{
  const TOKEN = `SKILLMARK_${crypto.randomBytes(4).toString("hex")}`;
  const repo = await makeRepo(
    { "notes.txt": "some notes\n" },
    {
      "auditor.md": `---
name: auditor
description: Audits a repository following house rules
skills: [houserules]
tools: [read_file, grep, glob, list_files]
---
You audit the repository. Follow the house rules skill exactly.`,
    },
    {
      "houserules.md": `---
name: houserules
description: House audit rules
---
When you produce your audit report you MUST begin the report with the exact token ${TOKEN} on its own line. This is mandatory.`,
    });
  try {
    const { out, turnEvents } = await runAgent(repo,
      "Use spawn_agent with agent_type 'auditor' to audit this repository, then relay the subagent's report verbatim.",
      `sess_c_${Date.now()}`);

    const called = toolsCalled(turnEvents);
    check("the model used the skill-declaring agent", called.includes("spawn_agent"), `called: ${called.join(", ") || "(none)"}`);
    // The token exists ONLY in the skill file — it can reach the answer only if
    // the skill was genuinely injected into the subagent's prompt.
    const sawToken = String(out.finalAnswer || "").includes(TOKEN)
      || turnEvents.some((e) => String(e.content || "").includes(TOKEN));
    check("skill content actually influenced the subagent", sawToken,
      "the skill token never appeared — injection may not have reached the model");
  } finally { await fs.rm(repo, { recursive: true, force: true }); }
}

await removeAllWorktrees();
await shutdownBackgroundSubagents({ graceMs: 200 });

console.log(`\n${passed} checks passed, ${failed} failed`);
if (failed) {
  console.error("\n❌ LIVE SUBAGENT E2E: FAIL — the real-model subagent flow is NOT verified.\n");
  process.exit(1);
}
console.log("\n✅ LIVE SUBAGENT E2E: PASS — a real model drove subagent selection, isolation, review/apply and skills.\n");
process.exit(0);
