/**
 * tests/benchmarkDrivers.test.mjs
 * Run with: node tests/benchmarkDrivers.test.mjs
 *
 * The cross-agent comparison layer: driver selection, and the guarantee that
 * makes a cross-agent number mean anything — that the corpus, the fixture
 * workspace, the validators and the scoring rules are identical whichever agent
 * ran. Offline; no API key, no external binaries.
 *
 * The load-bearing test is "shared scoring consistency": two different drivers
 * producing byte-identical workspaces must receive byte-identical verdicts. If
 * that ever stops holding, every comparison this layer prints is meaningless.
 */

import assert from "assert";
import fs from "fs/promises";
import path from "path";
import os from "os";

import {
  defineDriver, registerDriver, getDriver, listDrivers,
  externalCliDriver, scriptedDriver, formatDriverStatusReport,
} from "../bench/drivers.mjs";
import { runBenchmark, runSuite } from "../bench/runner.mjs";
import { loadCorpus } from "../bench/corpus.mjs";
import { compareAgents, formatAgentComparison } from "../bench/compare.mjs";
import { benchmarksRoot } from "../bench/paths.mjs";

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

const ARTIFACTS = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-drivers-"));
const corpus = await loadCorpus({ root: benchmarksRoot });
const HEALTH = corpus.find((b) => b.id === "backend/health-route-wiring");

/** Writes the correct health route. Used by two differently-named drivers. */
const solve = async ({ workspace, recorder }) => {
  const src = await fs.readFile(path.join(workspace, "server.mjs"), "utf-8");
  await fs.writeFile(path.join(workspace, "server.mjs"), src.replace(
    `  "GET /api/ping": () => ({ status: 200, body: { pong: true } }),`,
    `  "GET /api/ping": () => ({ status: 200, body: { pong: true } }),\n  "GET /api/health": () => ({ status: 200, body: { status: "ok" } }),`
  ), "utf-8");
  recorder.recordEvent({
    kind: "tool", toolName: "write_file", toolArgs: { path: "server.mjs" },
    content: '{"success":true}', status: "ok", durationMs: 4,
  });
  return {
    finalAnswer: "Added the /api/health route.",
    editedFiles: ["server.mjs"],
    usage: { inputTokens: 100, outputTokens: 40, llmCalls: 3 },
    runMetrics: { exitReason: "completed", iterations: 4, stoppedEarly: false, controller: { stopReason: null } },
  };
};

// ── the contract ────────────────────────────────────────────────────────────
console.log("\n══ DRIVER CONTRACT ═══════════════════════════════════════════");

await test("a driver without a run() function is rejected", () => {
  assert.throws(() => defineDriver({ name: "x" }), /no run\(\) function/);
});

await test("a driver without a name is rejected", () => {
  assert.throws(() => defineDriver({ run: async () => ({}) }), /needs a name/);
});

await test("a non-function preflight is rejected", () => {
  assert.throws(() => defineDriver({ name: "x", run: async () => ({}), preflight: "yes" }), /must be a function/);
});

await test("a minimal valid driver is accepted", () => {
  const d = defineDriver({ name: "minimal", run: async () => ({ finalAnswer: "" }) });
  assert.strictEqual(d.name, "minimal");
});

// ── selection ───────────────────────────────────────────────────────────────
console.log("\n══ DRIVER SELECTION ══════════════════════════════════════════");

await test("the built-in drivers are registered", () => {
  const names = listDrivers();
  for (const expected of ["kodo", "claude-code", "codex"]) {
    assert.ok(names.includes(expected), `${expected} is not registered (have: ${names.join(", ")})`);
  }
});

await test("kodo is still selectable and unchanged", () => {
  const d = getDriver("kodo");
  assert.strictEqual(d.name, "kodo");
  assert.strictEqual(typeof d.run, "function");
  assert.strictEqual(typeof d.preflight, "function");
});

await test("an unknown driver names what IS available instead of failing silently", () => {
  assert.throws(() => getDriver("gpt-9"), /unknown driver "gpt-9".*Available:.*kodo/s);
});

await test("a newly registered driver becomes selectable", () => {
  registerDriver(scriptedDriver(async () => ({ finalAnswer: "" }), { name: "test-only-driver" }));
  assert.strictEqual(getDriver("test-only-driver").name, "test-only-driver");
});

// ── external CLI adapter ────────────────────────────────────────────────────
console.log("\n══ EXTERNAL CLI ADAPTER ══════════════════════════════════════");

await test("a missing binary blocks honestly, and is never scored as a failure", async () => {
  const missing = externalCliDriver({
    name: "not-installed",
    command: "kodo-no-such-agent-binary",
    args: (p) => ["-p", p],
    installHint: "Install it first.",
  });
  const blocker = await missing.preflight({});
  assert.ok(blocker, "a missing binary must produce a blocker");
  assert.match(blocker.message, /kodo-no-such-agent-binary/);
  assert.match(blocker.message, /Install it first/);

  const r = await runBenchmark(HEALTH, { driver: missing, artifactsRoot: ARTIFACTS, writeArtifacts: false });
  assert.strictEqual(r.outcome, "blocked", "an uninstalled agent has not failed the task");
  assert.strictEqual(r.blocker.stage, "preflight");
});

await test("the adapter really runs a CLI in the workspace and scores the result", async () => {
  // `sh` stands in for a coding agent: it writes the route the benchmark wants.
  const shAgent = externalCliDriver({
    name: "sh-agent",
    command: "sh",
    // Preflight now proves the agent ANSWERS, not just that it exists — so a
    // stand-in must supply a probe in its own dialect.
    authProbeArgs: () => ["-c", "echo OK"],
    args: () => ["-c",
      `node -e 'const fs=require("fs");const p="server.mjs";const s=fs.readFileSync(p,"utf8");` +
      `fs.writeFileSync(p,s.replace(\`  "GET /api/ping": () => ({ status: 200, body: { pong: true } }),\`,` +
      `\`  "GET /api/ping": () => ({ status: 200, body: { pong: true } }),\\n  "GET /api/health": () => ({ status: 200, body: { status: "ok" } }),\`))' ` +
      `&& echo "added the health route"`,
    ],
  });
  assert.strictEqual(await shAgent.preflight({}), null, "sh should be on PATH");

  const r = await runBenchmark(HEALTH, { driver: shAgent, artifactsRoot: ARTIFACTS, writeArtifacts: false });
  assert.strictEqual(r.outcome, "pass", `expected pass, got ${r.outcome}: ${JSON.stringify(r.failedChecks)}`);
  assert.deepStrictEqual(r.workspaceChanges.modified, ["server.mjs"], "changes are measured from disk, not self-reported");
  assert.match(r.finalAnswer, /added the health route/, "stdout becomes the final answer");
});

await test("an agent that cannot self-report edited files is not accused of dishonesty", async () => {
  // It must really CHANGE something: comparing an empty self-report against an
  // empty workspace diff would agree by accident and prove nothing.
  const shAgent = externalCliDriver({
    name: "sh-agent-2", command: "sh", authProbeArgs: () => ["-c", "echo OK"],
    args: () => ["-c", `printf '// touched\\n' >> server.mjs && echo done`],
  });
  const r = await runBenchmark(HEALTH, { driver: shAgent, artifactsRoot: ARTIFACTS, writeArtifacts: false });

  assert.deepStrictEqual(r.workspaceChanges.modified, ["server.mjs"], "the agent really did change a file");
  assert.deepStrictEqual(r.agentReportedFiles, [], "…and reported nothing, because a CLI cannot");
  assert.strictEqual(r.reportMatchesDisk, null,
    "unknown must be recorded as null — scoring it `false` would read as a false claim and make every CLI agent look dishonest");
});

await test("a driver that CAN self-report is still held to it", async () => {
  const liar = scriptedDriver(async () => ({
    finalAnswer: "Edited server.mjs.",
    editedFiles: ["server.mjs"],   // claimed, never touched
    usage: null, runMetrics: null,
  }), { name: "claims-edits" });
  const r = await runBenchmark(HEALTH, { driver: liar, artifactsRoot: ARTIFACTS, writeArtifacts: false });
  assert.strictEqual(r.reportMatchesDisk, false, "the guard must not weaken the check for drivers that do report");
});

await test("a CLI agent reports null telemetry rather than zeros", async () => {
  const shAgent = externalCliDriver({ name: "sh-agent-3", command: "sh", args: () => ["-c", "echo done"], authProbeArgs: () => ["-c", "echo OK"] });
  const r = await runBenchmark(HEALTH, { driver: shAgent, artifactsRoot: ARTIFACTS, writeArtifacts: false });
  assert.strictEqual(r.metrics.iterations, null, "an unknown iteration count must not be reported as 0");
  assert.strictEqual(r.usage, null, "unknown token usage must not be reported as 0");
});

// ── the drivers listing ─────────────────────────────────────────────────────
console.log("\n══ DRIVERS LISTING: every driver is shown, blocked included ══");

const authBlocker = (name) => ({ status: "blocked", reason: "authentication", stage: "preflight", message: `${name} requires login — Not logged in · Please run /login` });

await test("both blocked external agents still appear, alongside authenticated Kodo", () => {
  const out = formatDriverStatusReport([
    { name: "claude-code", blocker: authBlocker("claude-code") },
    { name: "codex", blocker: authBlocker("codex") },
    { name: "kodo", blocker: null },
  ]);
  // Each driver gets its own labelled block — a blocked agent must never be
  // collapsed into a bare count.
  assert.match(out, /^ {2}claude-code:$/m, "claude-code is missing from the listing");
  assert.match(out, /^ {2}codex:$/m, "codex is missing from the listing");
  assert.match(out, /^ {2}kodo:$/m, "kodo is missing from the listing");
  assert.strictEqual((out.match(/🚧 blocked: authentication required/g) ?? []).length, 2);
  assert.match(out, /✅ authenticated/);
});

await test("Kodo still shows as authenticated when the others are blocked", () => {
  const out = formatDriverStatusReport([
    { name: "claude-code", blocker: authBlocker("claude-code") },
    { name: "kodo", blocker: null },
  ]);
  const kodoBlock = out.slice(out.indexOf("  kodo:"));
  assert.match(kodoBlock, /✅ authenticated/);
  assert.ok(!/🚧/.test(kodoBlock), "kodo must not inherit another driver's blocked state");
});

await test("every driver appears even when ALL are blocked", () => {
  const out = formatDriverStatusReport([
    { name: "claude-code", blocker: authBlocker("claude-code") },
    { name: "codex", blocker: authBlocker("codex") },
    { name: "kodo", blocker: { reason: "preflight", message: "OPENAI_API_KEY is not set" } },
  ]);
  for (const n of ["claude-code", "codex", "kodo"]) {
    assert.match(out, new RegExp(`^ {2}${n}:$`, "m"), `${n} vanished when everything was blocked`);
  }
});

await test("a multi-line blocker message cannot shatter the listing", () => {
  // codex reports a multi-line stack of ERROR lines. Printed raw, continuation
  // lines start at column 0 and the per-driver blocks visually collapse into
  // whichever driver printed last — which is what this listing is for.
  const messy = { reason: "probe_failed", message: "exited 1:\nReading additional input from stdin...\n2026-01-01T00:00:00Z ERROR manager: failed\n   indented junk" };
  const out = formatDriverStatusReport([
    { name: "codex", blocker: messy },
    { name: "kodo", blocker: null },
  ]);
  const lines = out.split("\n").filter((l) => l.trim());
  const stray = lines.filter((l) => /^\S/.test(l) && !/^Agent drivers|^\(ready/.test(l));
  assert.deepStrictEqual(stray, [], `these lines escaped their block: ${JSON.stringify(stray)}`);
  assert.match(out, /^ {2}kodo:$/m, "kodo must still be listed after a messy blocker");
});

await test("the summary names which agents are blocked, not just how many", () => {
  const out = formatDriverStatusReport([
    { name: "claude-code", blocker: authBlocker("claude-code") },
    { name: "kodo", blocker: null },
  ]);
  assert.match(out, /1 of 2 agent\(s\) blocked: claude-code/);
});

await test("no blocked agents means no blocked summary at all", () => {
  const out = formatDriverStatusReport([{ name: "kodo", blocker: null }]);
  assert.ok(!/blocked/.test(out), `a clean listing should not mention blocking: ${out}`);
});

await test("a blocked driver still prevents a comparison from running", async () => {
  // The listing is cosmetic; this is the guarantee that matters.
  const d = externalCliDriver({
    name: "blocked-agent", command: "blocked-agent", args: (p) => ["-p", p],
    execProbe: async (cmd) => cmd === "command"
      ? { spawned: true, code: 0, stdout: "/bin/blocked-agent", stderr: "", timedOut: false }
      : { spawned: true, code: 1, stdout: "Not logged in", stderr: "", timedOut: false },
  });
  assert.ok(await d.preflight({}), "must still block");
  const r = await runBenchmark(HEALTH, { driver: d, artifactsRoot: ARTIFACTS, writeArtifacts: false });
  assert.strictEqual(r.outcome, "blocked");
  assert.strictEqual(r.blocker.reason, "authentication");
});

// ── CLI wiring ──────────────────────────────────────────────────────────────
console.log("\n══ CLI COMMAND WIRING ════════════════════════════════════════");

await test("every command the CLI dispatches actually exists", async () => {
  // A real regression: `bench quality` was dispatched to a cmdQuality() that a
  // later edit had removed, so the command died with "cmdQuality is not
  // defined". Nothing caught it, because the mutation test imports gradeAll
  // directly rather than through the CLI. This is the cheap static guard.
  const src = await fs.readFile(new URL("../bench/cli.mjs", import.meta.url), "utf-8");
  const dispatched = [...src.matchAll(/case\s+"[\w-]+":\s*return\s+(cmd\w+)\s*\(/g)].map((m) => m[1]);
  const defined = new Set([...src.matchAll(/(?:async\s+)?function\s+(cmd\w+)\s*\(/g)].map((m) => m[1]));
  assert.ok(dispatched.length >= 6, `expected several dispatched commands, found ${dispatched.length}`);
  const missing = [...new Set(dispatched)].filter((f) => !defined.has(f));
  assert.deepStrictEqual(missing, [], "the CLI dispatches to functions that do not exist");
});

// ── shared scoring consistency ──────────────────────────────────────────────
console.log("\n══ SHARED SCORING ACROSS DRIVERS ═════════════════════════════");

await test("two different drivers producing the same workspace get the same verdict", async () => {
  // The guarantee the whole comparison rests on.
  const a = await runBenchmark(HEALTH, {
    driver: scriptedDriver(solve, { name: "agent-a" }), artifactsRoot: ARTIFACTS, writeArtifacts: false,
  });
  const b = await runBenchmark(HEALTH, {
    driver: scriptedDriver(solve, { name: "agent-b" }), artifactsRoot: ARTIFACTS, writeArtifacts: false,
  });

  assert.strictEqual(a.outcome, b.outcome);
  assert.strictEqual(a.score, b.score);
  assert.strictEqual(a.criticalPassed, b.criticalPassed);
  assert.strictEqual(a.criticalTotal, b.criticalTotal);
  assert.deepStrictEqual(
    a.checks.map((c) => [c.name, c.pass]),
    b.checks.map((c) => [c.name, c.pass]),
    "identical workspaces must yield identical checks whichever agent produced them"
  );
  assert.notStrictEqual(a.driver, b.driver, "…and they really were different drivers");
});

await test("each driver gets its own isolated fixture workspace", async () => {
  // Agent A vandalises the fixture; agent B must still see a pristine one.
  const vandal = scriptedDriver(async ({ workspace }) => {
    await fs.writeFile(path.join(workspace, "server.mjs"), "// wiped\n", "utf-8");
    return { finalAnswer: "", editedFiles: [], usage: null, runMetrics: null };
  }, { name: "vandal" });

  await runBenchmark(HEALTH, { driver: vandal, artifactsRoot: ARTIFACTS, writeArtifacts: false });
  const after = await runBenchmark(HEALTH, {
    driver: scriptedDriver(solve, { name: "agent-c" }), artifactsRoot: ARTIFACTS, writeArtifacts: false,
  });
  assert.strictEqual(after.outcome, "pass", "one agent's run must not contaminate the next");
});

await test("the same benchmark run by two drivers records which drove it", async () => {
  const r = await runBenchmark(HEALTH, {
    driver: scriptedDriver(solve, { name: "agent-x" }), artifactsRoot: ARTIFACTS, writeArtifacts: false,
  });
  assert.strictEqual(r.driver, "agent-x");
  assert.strictEqual(r.benchmarkId, HEALTH.id, "the benchmark identity is unchanged by the driver");
});

// ── cross-agent comparison ──────────────────────────────────────────────────
console.log("\n══ CROSS-AGENT COMPARISON ════════════════════════════════════");

const SUITE = [HEALTH, corpus.find((b) => b.id === "frontend/currency-helper-wiring")];

const fullSolver = scriptedDriver(async ({ benchmark, workspace, recorder }) => {
  if (benchmark.id === "backend/health-route-wiring") return solve({ workspace, recorder });
  const utils = await fs.readFile(path.join(workspace, "utils.ts"), "utf-8");
  await fs.writeFile(path.join(workspace, "utils.ts"),
    `${utils}\nexport function formatCurrency(amount: number): string {\n  return \`$\${amount.toFixed(2)}\`;\n}\n`, "utf-8");
  await fs.writeFile(path.join(workspace, "App.tsx"),
    `import { formatCurrency } from "./utils";\n\nexport function App() {\n  return <div>{formatCurrency(42.5)}</div>;\n}\n`, "utf-8");
  return {
    finalAnswer: "Done.", editedFiles: [], usage: { inputTokens: 200, outputTokens: 80, llmCalls: 4 },
    runMetrics: { exitReason: "completed", iterations: 5, controller: { stopReason: null, verificationRan: true, verificationCurrent: true } },
  };
}, { name: "strong-agent" });

const halfSolver = scriptedDriver(async ({ benchmark, workspace, recorder }) => {
  if (benchmark.id === "backend/health-route-wiring") return solve({ workspace, recorder });
  // Adds the helper, never wires it up.
  const utils = await fs.readFile(path.join(workspace, "utils.ts"), "utf-8");
  await fs.writeFile(path.join(workspace, "utils.ts"),
    `${utils}\nexport function formatCurrency(amount: number): string {\n  return \`$\${amount.toFixed(2)}\`;\n}\n`, "utf-8");
  return {
    finalAnswer: "I've implemented and wired up the helper.", editedFiles: [],
    usage: { inputTokens: 900, outputTokens: 300, llmCalls: 9 },
    runMetrics: { exitReason: "completed", iterations: 11, controller: { stopReason: null, verificationRan: false } },
  };
}, { name: "weak-agent" });

let strongReport;
let weakReport;

await test("one benchmark set runs across two different drivers", async () => {
  strongReport = await runSuite(SUITE, { driver: fullSolver, runId: "x-strong", artifactsRoot: ARTIFACTS, writeArtifacts: false });
  weakReport = await runSuite(SUITE, { driver: halfSolver, runId: "x-weak", artifactsRoot: ARTIFACTS, writeArtifacts: false });

  assert.strictEqual(strongReport.environment.driver, "strong-agent");
  assert.strictEqual(weakReport.environment.driver, "weak-agent");
  assert.strictEqual(strongReport.results.length, 2);
  assert.strictEqual(weakReport.results.length, 2);
  assert.strictEqual(strongReport.summary.successRate, 1);
  assert.ok(weakReport.summary.successRate < 1, "the weaker agent must not score the same");
});

await test("the comparison shows where the agents agree and where they differ", () => {
  const cmp = compareAgents([strongReport, weakReport]);
  assert.deepStrictEqual(cmp.agents.map((a) => a.driver), ["strong-agent", "weak-agent"]);
  assert.strictEqual(cmp.sameCorpus, true);
  assert.strictEqual(cmp.benchmarks.length, 2);

  const agreed = cmp.agreements.map((r) => r.benchmarkId);
  const differed = cmp.differences.map((r) => r.benchmarkId);
  assert.deepStrictEqual(agreed, ["backend/health-route-wiring"], "both solved this one identically");
  assert.deepStrictEqual(differed, ["frontend/currency-helper-wiring"], "only one wired the helper up");

  const [strongCell, weakCell] = cmp.differences[0].cells;
  assert.strictEqual(strongCell.outcome, "pass");
  assert.strictEqual(weakCell.outcome, "partial");
});

await test("the comparison measures verification honesty and false-positive claims per agent", () => {
  const cmp = compareAgents([strongReport, weakReport]);
  const [strong, weak] = cmp.agents;
  assert.strictEqual(strong.summary.falsePositiveSuccessRate, 0);
  assert.ok(weak.summary.falsePositiveSuccessRate > 0,
    "the weak agent claimed it wired the helper up and did not — that must show");
  assert.ok(strong.summary.verificationSuccessRate >= weak.summary.verificationSuccessRate);
});

await test("capability rates are derived from the shared corpus tags, not a second scoring system", () => {
  const cmp = compareAgents([strongReport, weakReport]);
  const [strong, weak] = cmp.agents;
  // Both suite members are tagged `wiring`; only the strong agent passes both.
  assert.strictEqual(strong.capabilities.wiring.total, 2);
  assert.strictEqual(strong.capabilities.wiring.passed, 2);
  assert.strictEqual(weak.capabilities.wiring.passed, 1);
  // A capability nothing in this suite exercises reports null, never 0%.
  assert.strictEqual(strong.capabilities.resume, null,
    "an unexercised capability must be blank, not a zero score");
});

await test("a corpus mismatch between agents is surfaced, not silently intersected", async () => {
  const partial = await runSuite([HEALTH], { driver: fullSolver, runId: "x-one", artifactsRoot: ARTIFACTS, writeArtifacts: false });
  const cmp = compareAgents([strongReport, partial]);
  assert.strictEqual(cmp.sameCorpus, false);
  const row = cmp.benchmarks.find((r) => r.benchmarkId === "frontend/currency-helper-wiring");
  assert.strictEqual(row.cells[1].outcome, "not_run");
});

await test("comparing fewer than two agents is an error", () => {
  assert.throws(() => compareAgents([strongReport]), /at least two reports/);
});

await test("the rendered side-by-side names both agents and marks disagreements", () => {
  const text = formatAgentComparison(compareAgents([strongReport, weakReport]));
  assert.match(text, /strong-agent/);
  assert.match(text, /weak-agent/);
  assert.match(text, /≠ frontend\/currency-helper-wiring/, "a disagreement must be marked");
  assert.match(text, /FALSE POSITIVE rate/);
  assert.match(text, /capabilities/);
  assert.match(text, /1 disagreement\(s\), 1 agreement\(s\)/);
});

await test("an agent with no telemetry renders as `—`, never as zero cost", async () => {
  const cliReport = await runSuite([HEALTH], {
    driver: externalCliDriver({ name: "sh-agent-4", command: "sh", args: () => ["-c", "echo hi"], authProbeArgs: () => ["-c", "echo OK"] }),
    runId: "x-cli", artifactsRoot: ARTIFACTS, writeArtifacts: false,
  });
  const text = formatAgentComparison(compareAgents([strongReport, cliReport]));
  const costLine = text.split("\n").find((l) => l.includes("avg tokens"));
  assert.match(costLine, /—/, `an agent that reports no tokens must show "—", got: ${costLine}`);
});

await fs.rm(ARTIFACTS, { recursive: true, force: true }).catch(() => {});

console.log(`\n${"═".repeat(62)}`);
console.log(`  benchmark drivers: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(62)}\n`);
process.exit(failed === 0 ? 0 : 1);
