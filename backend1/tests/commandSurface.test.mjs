/**
 * tests/commandSurface.test.mjs
 * Run with: node tests/commandSurface.test.mjs
 *
 * The built-in command surface, driven through the REAL handleSlashCommand —
 * the same function the HTTP route calls.
 *
 * Two properties matter here:
 *   1. /commands is a real command that lists the custom registry, and /help
 *      lists the built-ins. Neither returns "unknown".
 *   2. Runtime introspection output (/memory, /skills, /agents, /hooks, /mcp)
 *      stays clearly labelled as Kodo's own state and never masquerades as
 *      project source.
 *
 * /init is excluded: it calls a live model. Its evidence layer is covered
 * separately in projectEvidence.test.mjs.
 */

import assert from "assert";
import path from "path";
import fs from "fs/promises";
import os from "os";

import { handleSlashCommand } from "../routes/plannerAgent.mjs";
import { RESERVED_COMMANDS, invalidateCommandCache } from "../services/slashCommands.mjs";

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

async function makeWorkspace(files = {}) {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-surface-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(ws, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
  }
  return ws;
}
const run = (cmd, ws) => handleSlashCommand(cmd, { workspacePath: ws, modelRoute: {} });

console.log("\n📦 /commands is a real command");

await test("/commands is RECOGNISED (never 'Unknown command')", async () => {
  const ws = await makeWorkspace({});
  const out = await run("/commands", ws);
  assert.ok(out, "must return output");
  assert.ok(!/Unknown command/.test(out), `/commands must be a real command, got: ${String(out).slice(0, 120)}`);
  assert.match(out, /Custom slash commands/);
  await fs.rm(ws, { recursive: true, force: true });
});

await test("/commands lists a custom command with its name, source and description", async () => {
  invalidateCommandCache();
  const ws = await makeWorkspace({
    ".kodo/commands/deploy.md": "---\ndescription: Ship the app\ncategory: ops\n---\nDeploy it.",
  });
  const out = await run("/commands", ws);
  assert.match(out, /\/deploy/, "the command name must appear");
  assert.match(out, /Ship the app/, "its description must appear");
  assert.match(out, /\.kodo\/commands/, "its source must appear");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("/commands lists a SKILL-backed command too (merged model)", async () => {
  invalidateCommandCache();
  const ws = await makeWorkspace({
    ".kodo/skills/review/SKILL.md": "---\nname: review\ndescription: Review a diff\n---\nReview it.",
  });
  const out = await run("/commands", ws);
  assert.match(out, /\/review/);
  assert.match(out, /\.kodo\/skills/);
  await fs.rm(ws, { recursive: true, force: true });
});

await test("/commands says so plainly when there are none", async () => {
  invalidateCommandCache();
  const ws = await makeWorkspace({});
  const out = await run("/commands", ws);
  assert.match(out, /None defined/i, "an empty registry must be stated, not implied");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("/commands reflects a change WITHOUT a restart", async () => {
  invalidateCommandCache();
  const ws = await makeWorkspace({ ".kodo/commands/one.md": "---\ndescription: First\n---\nONE" });
  assert.match(await run("/commands", ws), /\/one/);

  await new Promise((r) => setTimeout(r, 15));
  await fs.writeFile(path.join(ws, ".kodo", "commands", "two.md"), "---\ndescription: Second\n---\nTWO");
  const after = await run("/commands", ws);
  assert.match(after, /\/two/, "a newly added command must appear");
  assert.match(after, /\/one/, "and the existing one must remain");

  await fs.rm(path.join(ws, ".kodo", "commands", "one.md"));
  await new Promise((r) => setTimeout(r, 15));
  const removed = await run("/commands", ws);
  assert.ok(!/\/one\b/.test(removed), "a removed command must disappear");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("/commands reports a shadowed built-in as a conflict", async () => {
  invalidateCommandCache();
  const ws = await makeWorkspace({ ".kodo/commands/help.md": "hijack" });
  const out = await run("/commands", ws);
  assert.match(out, /Conflicts/i);
  assert.match(out, /built-in/i);
  await fs.rm(ws, { recursive: true, force: true });
});

console.log("\n📦 /help lists built-ins and separates project from runtime");

await test("/help lists every built-in command", async () => {
  const ws = await makeWorkspace({});
  const out = await run("/help", ws);
  for (const cmd of ["/init", "/commands", "/memory", "/skills", "/agents", "/hooks", "/mcp", "/help"]) {
    assert.ok(out.includes(cmd), `${cmd} must be listed in /help`);
  }
  await fs.rm(ws, { recursive: true, force: true });
});

await test("/help groups PROJECT commands separately from RUNTIME introspection", async () => {
  const ws = await makeWorkspace({});
  const out = await run("/help", ws);
  assert.match(out, /\*\*Your project\*\*/);
  assert.match(out, /\*\*Kodo runtime\*\*/);
  // /init must sit under the project heading, /memory under runtime.
  const projectIdx = out.indexOf("**Your project**");
  const runtimeIdx = out.indexOf("**Kodo runtime**");
  assert.ok(projectIdx < out.indexOf("/init") && out.indexOf("/init") < runtimeIdx,
    "/init belongs to the project group");
  assert.ok(out.indexOf("/memory") > runtimeIdx, "/memory belongs to the runtime group");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("/help states that runtime output is not project evidence", async () => {
  const ws = await makeWorkspace({});
  const out = await run("/help", ws);
  assert.match(out, /never used as evidence about your project/i);
  await fs.rm(ws, { recursive: true, force: true });
});

console.log("\n📦 unknown commands still fail clearly");

await test("an unknown command is rejected with a pointer to /help", async () => {
  const ws = await makeWorkspace({});
  const out = await run("/definitelynotacommand", ws);
  assert.match(out, /Unknown command/);
  assert.match(out, /\/help/);
  await fs.rm(ws, { recursive: true, force: true });
});

await test("a non-command message is not treated as one", async () => {
  const ws = await makeWorkspace({});
  assert.strictEqual(await run("just a normal message", ws), null);
  await fs.rm(ws, { recursive: true, force: true });
});

console.log("\n📦 built-ins remain reserved");

await test("every built-in name is reserved against shadowing", () => {
  for (const name of ["help", "init", "memory", "skills", "hooks", "agents", "mcp", "commands"]) {
    assert.ok(RESERVED_COMMANDS.has(name), `/${name} must be reserved`);
  }
});

await test("a project file cannot take over a built-in surface", async () => {
  invalidateCommandCache();
  const ws = await makeWorkspace({ ".kodo/commands/memory.md": "HIJACKED BODY" });
  const out = await run("/memory", ws);
  assert.ok(!/HIJACKED BODY/.test(out), "the built-in must still answer /memory");
  await fs.rm(ws, { recursive: true, force: true });
});

console.log("\n📦 runtime introspection stays labelled as runtime");

await test("runtime surfaces describe Kodo, not the project", async () => {
  invalidateCommandCache();
  const ws = await makeWorkspace({
    // Real project files that must NOT show up in runtime output.
    "package.json": '{"name":"my-app","dependencies":{"fastify":"^4"}}',
    "src/server.js": "const app = require('fastify')();",
  });
  for (const cmd of ["/skills", "/agents", "/hooks"]) {
    const out = await run(cmd, ws);
    assert.ok(out, `${cmd} must return output`);
    assert.ok(!/my-app/.test(out), `${cmd} must not report project package data`);
    assert.ok(!/src\/server\.js/.test(out), `${cmd} must not report project source files`);
  }
  await fs.rm(ws, { recursive: true, force: true });
});

await test("/commands reports only commands, not project source files", async () => {
  invalidateCommandCache();
  const ws = await makeWorkspace({
    "package.json": '{"name":"my-app"}',
    "README.md": "# my-app",
    ".kodo/commands/deploy.md": "---\ndescription: Ship\n---\nDeploy.",
  });
  const out = await run("/commands", ws);
  assert.match(out, /\/deploy/);
  assert.ok(!/my-app/.test(out), "a project manifest must not appear in the command listing");
  assert.ok(!/README/.test(out), "a project README must not appear in the command listing");
  await fs.rm(ws, { recursive: true, force: true });
});

await test("/commands does not expose command bodies", async () => {
  invalidateCommandCache();
  const ws = await makeWorkspace({
    ".kodo/commands/secret.md": "---\ndescription: A command\n---\nSECRET_BODY_MARKER",
  });
  const out = await run("/commands", ws);
  assert.ok(!/SECRET_BODY_MARKER/.test(out), "bodies must never be listed");
  await fs.rm(ws, { recursive: true, force: true });
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
