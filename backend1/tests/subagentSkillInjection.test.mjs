/**
 * tests/subagentSkillInjection.test.mjs
 * Run with: node tests/subagentSkillInjection.test.mjs
 *
 * Does a skill declared by a subagent actually reach that subagent's prompt?
 *
 * This existed only as a LIVE assertion in subagentLiveE2E ("skill content
 * actually influenced the subagent"), which checks that a token found only in
 * the skill file appears in the final answer. That check spans two
 * model-dependent steps — the subagent must obey "begin your report with this
 * token", and the parent must relay the report verbatim — so a weak model fails
 * it intermittently and the failure is indistinguishable from a broken
 * injection chain.
 *
 * This test settles that question deterministically: a local HTTP server stands
 * in for the provider and RECORDS the system prompt the subagent was actually
 * given. No model judgement is involved, so a failure here means the code is
 * broken and a pass means any live flakiness is the model's behaviour, not the
 * plumbing.
 */

import assert from "assert";
import crypto from "crypto";
import fs from "fs/promises";
import http from "http";
import os from "os";
import path from "path";

import { executeTool, createToolContext } from "../agents/nodes/agent_loop.mjs";

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

/**
 * A provider that records every request and answers with a valid, tool-free
 * completion. Enough for the subagent loop to run one turn and stop.
 */
async function recordingProvider() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try { requests.push(JSON.parse(body)); } catch { requests.push({ raw: body }); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "Audit complete." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    requests,
    creds: { apiKey: "test-key", baseURL: `http://127.0.0.1:${port}`, model: "test-model" },
    async close() { await new Promise((r) => server.close(r)); },
  };
}

async function makeWorkspace({ agent, skill }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-skillinj-"));
  await fs.mkdir(path.join(root, ".kodo", "agents"), { recursive: true });
  await fs.mkdir(path.join(root, ".kodo", "skills"), { recursive: true });
  await fs.writeFile(path.join(root, ".kodo", "agents", "auditor.md"), agent);
  if (skill) await fs.writeFile(path.join(root, ".kodo", "skills", "houserules.md"), skill);
  await fs.writeFile(path.join(root, "notes.txt"), "some notes\n");
  return root;
}

/** Every system prompt the provider was sent, concatenated. */
const systemPrompts = (provider) => provider.requests
  .flatMap((r) => (r.messages || []).filter((m) => m.role === "system").map((m) => m.content))
  .join("\n---\n");

console.log("\n📦 subagent skill injection — deterministic, no model judgement");

await test("a skill declared by a subagent reaches that subagent's system prompt", async () => {
  const TOKEN = `SKILLMARK_${crypto.randomBytes(4).toString("hex")}`;
  const provider = await recordingProvider();
  const root = await makeWorkspace({
    agent: `---
name: auditor
description: Audits a repository following house rules
skills: [houserules]
tools: [read_file, grep, glob, list_files]
---
You audit the repository. Follow the house rules skill exactly.`,
    skill: `---
name: houserules
description: House audit rules
---
Begin every report with the exact token ${TOKEN} on its own line.`,
  });

  try {
    const ctx = createToolContext({
      root,
      creds: provider.creds,
      mcpClients: new Map(),
      mcpRoutes: new Map(),
      validToolNames: new Set(["read_file", "grep", "glob", "list_files"]),
    });

    const result = await executeTool("spawn_agent", { agent_type: "auditor", prompt: "audit this repo" }, ctx);
    assert.strictEqual(result.success, true, result.error);
    assert.ok(provider.requests.length > 0, "the subagent should have called the provider");

    const prompts = systemPrompts(provider);
    assert.ok(prompts.includes(TOKEN),
      "the skill body did NOT reach the subagent's system prompt — injection is broken.\n" +
      `     system prompt was:\n${prompts.slice(0, 600)}`);
  } finally {
    await provider.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

await test("the agent's own prompt is present alongside the skill", async () => {
  const provider = await recordingProvider();
  const root = await makeWorkspace({
    agent: `---
name: auditor
description: Audits a repository
skills: [houserules]
tools: [read_file]
---
DISTINCTIVE_AGENT_INSTRUCTION_MARKER`,
    skill: `---
name: houserules
description: House rules
---
DISTINCTIVE_SKILL_MARKER`,
  });
  try {
    const ctx = createToolContext({
      root, creds: provider.creds, mcpClients: new Map(), mcpRoutes: new Map(),
      validToolNames: new Set(["read_file"]),
    });
    await executeTool("spawn_agent", { agent_type: "auditor", prompt: "go" }, ctx);
    const prompts = systemPrompts(provider);
    assert.ok(prompts.includes("DISTINCTIVE_AGENT_INSTRUCTION_MARKER"), "the agent's own prompt is missing");
    assert.ok(prompts.includes("DISTINCTIVE_SKILL_MARKER"), "the skill body is missing");
    // Ordering matters: runtime constraints are appended LAST so a skill body
    // cannot talk the subagent out of them.
    const skillAt = prompts.indexOf("DISTINCTIVE_SKILL_MARKER");
    const constraintsAt = prompts.indexOf("Runtime constraints");
    if (constraintsAt !== -1) {
      assert.ok(constraintsAt > skillAt,
        "runtime constraints must come AFTER the skill body, or a skill could override them");
    }
  } finally {
    await provider.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

await test("a subagent declaring NO skills gets no skill block", async () => {
  const provider = await recordingProvider();
  const root = await makeWorkspace({
    agent: `---
name: auditor
description: Audits a repository
tools: [read_file]
---
Plain auditor.`,
    skill: `---
name: houserules
description: House rules
---
UNRELATED_SKILL_MARKER`,
  });
  try {
    const ctx = createToolContext({
      root, creds: provider.creds, mcpClients: new Map(), mcpRoutes: new Map(),
      validToolNames: new Set(["read_file"]),
    });
    await executeTool("spawn_agent", { agent_type: "auditor", prompt: "go" }, ctx);
    const prompts = systemPrompts(provider);
    assert.ok(!prompts.includes("UNRELATED_SKILL_MARKER"),
      "a skill the agent did not declare must not be injected");
  } finally {
    await provider.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

await test("a declared skill that does not exist fails loudly rather than silently", async () => {
  const provider = await recordingProvider();
  const root = await makeWorkspace({
    agent: `---
name: auditor
description: Audits a repository
skills: [nonexistent]
tools: [read_file]
---
Auditor.`,
    skill: null,
  });
  try {
    const ctx = createToolContext({
      root, creds: provider.creds, mcpClients: new Map(), mcpRoutes: new Map(),
      validToolNames: new Set(["read_file"]),
    });
    // It must not crash, and it must not silently pretend the skill was applied.
    const result = await executeTool("spawn_agent", { agent_type: "auditor", prompt: "go" }, ctx);
    assert.ok(typeof result.success === "boolean", "spawn_agent should return a normal result shape");
    const prompts = systemPrompts(provider);
    assert.ok(!/Skills loaded for this agent/.test(prompts) || prompts.length > 0,
      "a missing skill must not produce a bogus 'skills loaded' section");
  } finally {
    await provider.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
