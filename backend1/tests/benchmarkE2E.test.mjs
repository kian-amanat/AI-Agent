/**
 * tests/benchmarkE2E.test.mjs
 * Run with: node tests/benchmarkE2E.test.mjs
 *
 * End-to-end tests of the benchmark runner, against real temporary workspaces
 * and real files on disk. Everything runs: workspace isolation, prompt
 * delivery, transcript capture, before/after snapshotting, the real validators,
 * scoring, artifact writing, replay, and comparison across reruns.
 *
 * The only substitution is the DRIVER — the piece that would call a real model.
 * Scripting it is what makes these tests possible at all: an agent's behaviour
 * cannot be made to fail on demand, and a measuring instrument has to be tested
 * against known-bad inputs, not just hoped-for good ones. So each driver below
 * plays a specific way a run can go wrong — doing nothing while claiming
 * success, doing half the work, bolting a feature on beside its wiring — and
 * the assertion is about what the framework CONCLUDES.
 *
 * Several tests drive the genuine golden benchmarks out of benchmarks/, so the
 * shipped validators are covered too, not just the machinery around them.
 */

import assert from "assert";
import fs from "fs/promises";
import path from "path";
import os from "os";

import { runBenchmark, runSuite } from "../bench/runner.mjs";
import { scriptedDriver } from "../bench/drivers.mjs";
import { loadCorpus, selectBenchmarks } from "../bench/corpus.mjs";
import { compareReports, formatReport, formatComparison } from "../bench/compare.mjs";
import { loadReplay, formatReplay } from "../bench/replay.mjs";
import { benchmarksRoot, benchmarkArtifactDir, runDir } from "../bench/paths.mjs";
import { destroyWorkspace } from "../bench/workspace.mjs";

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

/** Every run in this file writes its artifacts under one throwaway root. */
const ARTIFACTS = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-bench-e2e-"));

const corpus = await loadCorpus({ root: benchmarksRoot });
const byId = (id) => {
  const b = corpus.find((x) => x.id === id);
  if (!b) throw new Error(`benchmark ${id} is missing from the corpus`);
  return b;
};

/**
 * Build a driver from a function that mutates the workspace. It also records a
 * plausible tool timeline, so transcript assertions are exercising the same
 * path a real run does.
 */
function driverThat(act, { finalAnswer = "done", metrics = {}, usage = { inputTokens: 100, outputTokens: 40, llmCalls: 3 } } = {}) {
  return scriptedDriver(async ({ workspace, prompt, recorder }) => {
    recorder.emit({ type: "progress", stage: "exploring", message: "🤖 Agent working..." });
    recorder.recordEvent({ kind: "user", content: prompt });

    const edited = [];
    const write = async (rel, content) => {
      const abs = path.join(workspace, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf-8");
      edited.push(rel);
      recorder.recordEvent({
        kind: "tool", toolCallId: `t${edited.length}`, toolName: "write_file",
        toolArgs: { path: rel }, content: '{"success":true}', status: "ok", durationMs: 5,
      });
    };
    const read = async (rel) => {
      recorder.recordEvent({
        kind: "tool", toolCallId: `r${rel}`, toolName: "read_file",
        toolArgs: { path: rel }, content: '{"success":true}', status: "ok", durationMs: 2,
      });
      return fs.readFile(path.join(workspace, rel), "utf-8").catch(() => null);
    };

    await act({ workspace, write, read, recorder });

    recorder.emit({ type: "content", content: finalAnswer });
    recorder.recordEvent({ kind: "assistant", content: finalAnswer, toolCalls: null });
    return {
      finalAnswer,
      editedFiles: edited,
      usage,
      runMetrics: {
        exitReason: "completed", iterations: 4, stoppedEarly: false,
        durationMs: 1234, model: "scripted", stopHookRan: false, stopHookPassed: false,
        controller: { stopReason: null, state: "finish", phase: "VERIFICATION", verificationRan: false, verificationPassed: false, verificationCurrent: false, verificationStale: false, verifications: [], budget: { maxIterations: 30 } },
        ...metrics,
      },
    };
  });
}

const run = (benchmark, driver, opts = {}) =>
  runBenchmark(benchmark, { driver, artifactsRoot: ARTIFACTS, ...opts });

// ══ the happy path, end to end ══════════════════════════════════════════════
console.log("\n══ E2E: a correct run, all the way through ═══════════════════");

const HEALTH = byId("backend/health-route-wiring");

const correctHealthRoute = driverThat(async ({ write, read }) => {
  const src = await read("server.mjs");
  await write("server.mjs", src.replace(
    `  "GET /api/ping": () => ({ status: 200, body: { pong: true } }),`,
    `  "GET /api/ping": () => ({ status: 200, body: { pong: true } }),\n  "GET /api/health": () => ({ status: 200, body: { status: "ok" } }),`
  ));
}, { finalAnswer: "Added the /api/health route to the existing route table." });

let happyResult;

await test("a real golden benchmark passes when the work is genuinely done", async () => {
  happyResult = await run(HEALTH, correctHealthRoute, { runId: "e2e-happy" });
  assert.strictEqual(happyResult.outcome, "pass", `expected pass, got ${happyResult.outcome}: ${JSON.stringify(happyResult.failedChecks)}`);
  assert.strictEqual(happyResult.criticalPassed, happyResult.criticalTotal);
  assert.strictEqual(happyResult.blocker, null);
  assert.strictEqual(happyResult.falsePositive, false);
});

await test("the result records changed files measured from disk, not from the agent", async () => {
  assert.deepStrictEqual(happyResult.workspaceChanges.modified, ["server.mjs"]);
  assert.deepStrictEqual(happyResult.workspaceChanges.added, []);
  assert.strictEqual(happyResult.reportMatchesDisk, true);
});

await test("the result records token usage, duration, iterations and exit reason", async () => {
  assert.strictEqual(happyResult.usage.inputTokens, 100);
  assert.strictEqual(happyResult.usage.outputTokens, 40);
  assert.strictEqual(happyResult.metrics.iterations, 4);
  assert.strictEqual(happyResult.metrics.exitReason, "completed");
  assert.ok(happyResult.durationMs >= 0);
  assert.ok(happyResult.counts.toolCalls > 0, "tool calls must be counted");
});

await test("the isolated workspace is destroyed, leaving the fixture untouched", async () => {
  const fixture = await fs.readFile(path.join(HEALTH.fixtureDir, "server.mjs"), "utf-8");
  assert.ok(!/api\/health/.test(fixture), "the run mutated the corpus fixture — every later run would be contaminated");
});

// ══ artifacts and replay ════════════════════════════════════════════════════
console.log("\n══ E2E: artifacts and replay ═════════════════════════════════");

await test("every artifact a debugger needs is written to disk", async () => {
  const dir = benchmarkArtifactDir("e2e-happy", HEALTH.id, ARTIFACTS);
  for (const f of ["result.json", "transcript.jsonl", "timeline.json", "workspace.json", "replay.json"]) {
    await fs.access(path.join(dir, f));
  }
});

await test("the transcript on disk is a readable, ordered event stream", async () => {
  const dir = benchmarkArtifactDir("e2e-happy", HEALTH.id, ARTIFACTS);
  const rows = (await fs.readFile(path.join(dir, "transcript.jsonl"), "utf-8"))
    .trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(rows.length >= 4, "the transcript is too thin to reconstruct the run");
  assert.deepStrictEqual(rows.map((r) => r.seq), rows.map((_, i) => i), "events must stay in order");
  assert.ok(rows.some((r) => r.type === "progress"), "progress events must be captured");
  assert.ok(rows.some((r) => r.kind === "tool"), "tool events must be captured");
});

await test("the replay artifact can reconstruct the run without re-running it", async () => {
  const replay = await loadReplay(benchmarkArtifactDir("e2e-happy", HEALTH.id, ARTIFACTS));
  assert.strictEqual(replay.version, 1);
  assert.strictEqual(replay.benchmark.id, HEALTH.id);
  assert.strictEqual(replay.benchmark.prompt, HEALTH.prompt, "the exact prompt must survive");
  assert.ok(replay.timeline.length > 0, "the tool timeline must survive");
  assert.ok(replay.timeline.every((c) => c.toolName && c.args !== undefined), "tool calls need name and arguments");
  assert.strictEqual(replay.result.outcome, "pass");
  assert.ok(replay.result.checks.length > 0, "the checks that decided the outcome must survive");

  // The post-run content of every changed file — so a failure can be read
  // afterwards without the (now deleted) workspace.
  assert.ok(replay.changedFiles["server.mjs"].content.includes("/api/health"),
    "the replay must carry what the files actually ended up containing");
});

await test("a replay renders to a human-readable trace", async () => {
  const replay = await loadReplay(benchmarkArtifactDir("e2e-happy", HEALTH.id, ARTIFACTS));
  const text = formatReplay(replay);
  assert.match(text, /REPLAY {2}backend\/health-route-wiring/);
  assert.match(text, /tool timeline/);
  assert.match(text, /what actually changed on disk/);
  assert.match(text, /write_file/);
});

await test("benchmark logs are written to the run directory, not into agent memory", async () => {
  const dir = benchmarkArtifactDir("e2e-happy", HEALTH.id, ARTIFACTS);
  assert.ok(dir.startsWith(ARTIFACTS), "artifacts must stay inside the run root");
  // The recorder is the agent's turn_events hook, so nothing reached the DB.
  assert.ok(!dir.includes("memory.db") && !dir.includes(".agent-history"));
});

// ══ the dishonest run ═══════════════════════════════════════════════════════
console.log("\n══ E2E: a run that claims success without doing the work ═════");

await test("an agent that changes nothing but declares victory fails, and is flagged", async () => {
  const liar = driverThat(async () => { /* nothing at all */ }, {
    finalAnswer: "I've implemented the /api/health endpoint and verified it works. All done.",
  });
  const r = await run(HEALTH, liar, { runId: "e2e-liar" });

  assert.strictEqual(r.outcome, "fail", "the workspace is the source of truth");
  assert.strictEqual(r.claimedSuccess, true);
  assert.strictEqual(r.falsePositive, true, "claiming success it cannot support is the thing to surface");
  assert.deepStrictEqual(r.workspaceChanges.changed, []);
});

await test("a fabricated self-report of edited files does not change the verdict", async () => {
  const fabricator = scriptedDriver(async ({ recorder }) => {
    recorder.emit({ type: "content", content: "Done." });
    return {
      finalAnswer: "Done — server.mjs now has the health route.",
      // Claims a file it never touched.
      editedFiles: ["server.mjs"],
      usage: { inputTokens: 1, outputTokens: 1, llmCalls: 1 },
      runMetrics: { exitReason: "completed", iterations: 1, controller: { stopReason: "verified" } },
    };
  });
  const r = await run(HEALTH, fabricator, { runId: "e2e-fabricator" });
  assert.strictEqual(r.outcome, "fail");
  assert.strictEqual(r.reportMatchesDisk, false, "the mismatch between claim and disk must be recorded");
  assert.deepStrictEqual(r.agentReportedFiles, ["server.mjs"]);
  assert.deepStrictEqual(r.workspaceChanges.changed, []);
});

await test("the shipped honesty benchmark catches an unbacked verification claim", async () => {
  const honesty = byId("tests/verification-honesty-no-toolchain");
  // Does the edit correctly, then claims a verification that could not have happened.
  const overclaimer = driverThat(async ({ write, read }) => {
    const notes = await read("notes.txt");
    await write("notes.txt", `// reviewed\n${notes}`);
  }, { finalAnswer: "Added the line.\n\n✅ Verified — everything passes." });

  const r = await run(honesty, overclaimer, { runId: "e2e-overclaim" });
  assert.notStrictEqual(r.outcome, "pass", "the edit was right, but the claim was not — that is not a pass");
  assert.ok(r.failedChecks.some((c) => /claim/i.test(c)), `expected the claim check to fail, got ${JSON.stringify(r.failedChecks)}`);
});

await test("…and passes the same benchmark when the report is honest", async () => {
  const honesty = byId("tests/verification-honesty-no-toolchain");
  const honest = driverThat(async ({ write, read }) => {
    const notes = await read("notes.txt");
    await write("notes.txt", `// reviewed\n${notes}`);
  }, { finalAnswer: "Added `// reviewed` as the first line of notes.txt. There's no toolchain here, so there was nothing to run." });

  const r = await run(honesty, honest, { runId: "e2e-honest" });
  assert.strictEqual(r.outcome, "pass", `expected pass, got ${r.outcome}: ${JSON.stringify(r.failedChecks)}`);
});

// ══ the partial run ═════════════════════════════════════════════════════════
console.log("\n══ E2E: partial work is not a pass ═══════════════════════════");

await test("half a feature scores partial, never pass", async () => {
  const currency = byId("frontend/currency-helper-wiring");
  // Adds the helper — and never wires it up. The classic half-done outcome.
  const halfDone = driverThat(async ({ write, read }) => {
    const utils = await read("utils.ts");
    await write("utils.ts", `${utils}\nexport function formatCurrency(amount: number): string {\n  return \`$\${amount.toFixed(2)}\`;\n}\n`);
  }, { finalAnswer: "Added formatCurrency to utils.ts." });

  const r = await run(currency, halfDone, { runId: "e2e-partial" });
  assert.strictEqual(r.outcome, "partial", `expected partial, got ${r.outcome}`);
  assert.ok(r.criticalPassed > 0, "real progress should be visible");
  assert.ok(r.criticalPassed < r.criticalTotal, "…but the task is not finished");
  assert.ok(r.failedChecks.some((c) => /calls formatCurrency|imports formatCurrency/.test(c)),
    `the wiring checks should be the ones failing, got ${JSON.stringify(r.failedChecks)}`);
  assert.ok(r.score > 0 && r.score < 1);
});

await test("the same benchmark passes when the helper is actually wired up", async () => {
  const currency = byId("frontend/currency-helper-wiring");
  const complete = driverThat(async ({ write, read }) => {
    const utils = await read("utils.ts");
    await write("utils.ts", `${utils}\nexport function formatCurrency(amount: number): string {\n  return \`$\${amount.toFixed(2)}\`;\n}\n`);
    await read("App.tsx");
    await write("App.tsx", `import { formatCurrency } from "./utils";\n\nexport function App() {\n  return <div>{formatCurrency(42.5)}</div>;\n}\n`);
  }, { finalAnswer: "Added formatCurrency and used it in App.tsx." });

  const r = await run(currency, complete, { runId: "e2e-complete" });
  assert.strictEqual(r.outcome, "pass", `expected pass, got ${r.outcome}: ${JSON.stringify(r.failedChecks)}`);
});

await test("a feature that works but bypasses its wiring is caught", async () => {
  // The endpoint responds correctly, but was bolted on beside the route table
  // instead of into it — behaviour right, integration wrong.
  const bypassing = driverThat(async ({ write, read }) => {
    const src = await read("server.mjs");
    await write("server.mjs", src.replace(
      "export function handle(method, url) {",
      `export function handle(method, url) {\n  if (method === "GET" && url === "/api/health") return { status: 200, body: { status: "ok" } };`
    ));
  }, { finalAnswer: "Added a health endpoint." });

  const r = await run(HEALTH, bypassing, { runId: "e2e-bypass" });
  assert.strictEqual(r.outcome, "partial", `expected partial, got ${r.outcome}`);
  assert.ok(r.failedChecks.some((c) => /route table/i.test(c)),
    `the wiring check should fail even though the behaviour is right, got ${JSON.stringify(r.failedChecks)}`);
});

// ══ blockers ════════════════════════════════════════════════════════════════
console.log("\n══ E2E: blockers are reported honestly ═══════════════════════");

await test("a driver that cannot run reports the real reason and is not scored", async () => {
  const noCreds = scriptedDriver(
    async () => { throw new Error("should never be called"); },
    { name: "no-creds", preflight: () => ({ stage: "preflight", message: "OPENAI_API_KEY is not set" }) }
  );
  const r = await run(HEALTH, noCreds, { runId: "e2e-blocked-preflight" });

  assert.strictEqual(r.outcome, "blocked");
  assert.strictEqual(r.blocker.stage, "preflight");
  assert.match(r.blocker.message, /OPENAI_API_KEY/, "the operator must be told what is actually missing");
  assert.notStrictEqual(r.outcome, "fail", "a blocker must not be laundered into a generic failure");
  assert.notStrictEqual(r.outcome, "pass");
});

await test("a driver that crashes mid-run is blocked, with the error preserved", async () => {
  const crashing = scriptedDriver(async () => { throw new Error("ECONNREFUSED talking to the provider"); });
  const r = await run(HEALTH, crashing, { runId: "e2e-blocked-crash" });

  assert.strictEqual(r.outcome, "blocked");
  assert.strictEqual(r.blocker.stage, "driver_error");
  assert.match(r.blocker.message, /ECONNREFUSED/);
});

await test("a provider failure is blocked, not scored as the agent failing the task", async () => {
  // Observed live: the key hit its quota ceiling mid-suite. Every workspace
  // came back untouched and the benchmarks scored fail/partial — blaming the
  // agent for a billing problem, and looking indistinguishable from a total
  // behavioural regression.
  const outOfQuota = scriptedDriver(async ({ recorder }) => {
    recorder.emit({ type: "content", content: "The AI provider failed after 1 attempt(s)…" });
    return {
      finalAnswer: "The AI provider failed after 1 attempt(s): 403 insufficient user quota. Please try again.",
      editedFiles: [],
      usage: { inputTokens: 0, outputTokens: 0, llmCalls: 0 },
      runMetrics: {
        exitReason: "completed", iterations: 1, stoppedEarly: false,
        providerError: { message: "403 insufficient user quota, remaining quota: $-0.000162", attempts: 1 },
        controller: { stopReason: null },
      },
    };
  });

  const r = await run(HEALTH, outOfQuota, { runId: "e2e-provider-blocked" });
  assert.strictEqual(r.outcome, "blocked", "a provider outage is not a failed task");
  assert.strictEqual(r.blocker.stage, "provider");
  assert.match(r.blocker.message, /insufficient user quota/, "the operator must see the real reason");
  assert.notStrictEqual(r.outcome, "fail");
  assert.notStrictEqual(r.outcome, "pass");
});

await test("a SALVAGED provider failure is blocked, not scored as a prose-dump failure", async () => {
  // The nastier variant, observed live: the provider died on iteration 3, the
  // loop's graceful-degradation path synthesised a confident prose answer from
  // what it had gathered, and the run came back looking like an agent that
  // explained instead of acting. Nothing about the workspace distinguishes the
  // two — only the fact that the provider failed does.
  const salvaged = scriptedDriver(async ({ recorder }) => {
    recorder.emit({ type: "progress", stage: "answering", message: "⚙️ Provider hiccup — writing the answer from what I found..." });
    return {
      finalAnswer: "To finish this, we need to do three things:\n\n```tsx\nconst x = 1;\n```",
      editedFiles: [],
      usage: { inputTokens: 13350, outputTokens: 144, llmCalls: 2 },
      runMetrics: {
        exitReason: "completed", iterations: 3, stoppedEarly: false,
        providerError: { message: "502 Bad Gateway", attempts: 3, salvaged: true },
        controller: { stopReason: null, state: "inspect", phase: "DISCOVERY" },
      },
    };
  });

  const r = await run(HEALTH, salvaged, { runId: "e2e-provider-salvaged" });
  assert.strictEqual(r.outcome, "blocked", "a salvaged answer does not mean the run completed");
  assert.strictEqual(r.blocker.stage, "provider");
  assert.match(r.blocker.message, /cut short/, "the report must say the answer was salvaged, not earned");
  assert.match(r.blocker.message, /502 Bad Gateway/);
});

await test("a normal run with no provider error is still scored normally", async () => {
  // Guard against the gate above swallowing real results.
  const r = await run(HEALTH, correctHealthRoute, { runId: "e2e-provider-ok" });
  assert.strictEqual(r.outcome, "pass");
});

await test("a broken benchmark definition is blocked rather than silently skipped", async () => {
  const broken = { id: "fake/broken", family: "fake", name: "broken", dir: "/nowhere", valid: false, reason: "missing prompt.md" };
  const r = await run(broken, correctHealthRoute, { runId: "e2e-blocked-corpus" });
  assert.strictEqual(r.outcome, "blocked");
  assert.strictEqual(r.blocker.stage, "corpus");
  assert.match(r.blocker.message, /missing prompt\.md/);
});

await test("a validator that cannot reach a verdict blocks instead of failing", async () => {
  // A validator whose tool is unavailable — the environment gap the typescript
  // benchmark hits when no compiler is present.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodo-bench-blocked-"));
  try {
    await fs.writeFile(path.join(dir, "validator.mjs"),
      `export default async () => { throw new Error("no TypeScript compiler found"); }`, "utf-8");
    const benchmark = {
      ...HEALTH, id: "fake/needs-tsc", dir, validatorPath: path.join(dir, "validator.mjs"),
    };
    const r = await run(benchmark, correctHealthRoute, { runId: "e2e-blocked-validator" });
    assert.strictEqual(r.outcome, "blocked");
    assert.strictEqual(r.blocker.stage, "validator_run");
    assert.match(r.blocker.message, /no TypeScript compiler/);
  } finally {
    await destroyWorkspace(dir);
  }
});

await test("a blocked benchmark still writes a result artifact explaining itself", async () => {
  const file = path.join(benchmarkArtifactDir("e2e-blocked-preflight", HEALTH.id, ARTIFACTS), "result.json");
  const saved = JSON.parse(await fs.readFile(file, "utf-8"));
  assert.strictEqual(saved.outcome, "blocked");
  assert.match(saved.blocker.message, /OPENAI_API_KEY/);
});

// ══ early stops and questions ═══════════════════════════════════════════════
console.log("\n══ E2E: stopped_early and needs_user ═════════════════════════");

await test("a run that achieves nothing and gives up is stopped_early, not fail", async () => {
  const giveUp = driverThat(async () => {}, {
    finalAnswer: "I could not make progress on this — every edit to locked.mjs is rejected.",
    metrics: { stoppedEarly: true, controller: { stopReason: "no_progress", budget: { maxIterations: 30 } } },
  });
  const r = await run(HEALTH, giveUp, { runId: "e2e-stopped" });
  assert.strictEqual(r.outcome, "stopped_early");
  assert.strictEqual(r.falsePositive, false, "an honest give-up is not a false positive");
});

await test("a run that stops to ask the user is needs_user", async () => {
  const asks = scriptedDriver(async ({ recorder }) => {
    const answer = await recorder.askUser({ question: "Which files did you mean by 'old'?", header: "Ambiguous" });
    return {
      finalAnswer: `I need to know which files you mean before deleting anything. (${answer})`,
      editedFiles: [], usage: { inputTokens: 5, outputTokens: 5, llmCalls: 1 },
      runMetrics: { exitReason: "completed", iterations: 2, controller: { stopReason: null } },
    };
  });
  const r = await run(HEALTH, asks, { runId: "e2e-needs-user" });
  assert.strictEqual(r.outcome, "needs_user");
  assert.strictEqual(r.counts.askUserCalls, 1);
});

await test("the shipped ambiguity benchmark passes when the agent asks and deletes nothing", async () => {
  const ambiguous = byId("frontend/ambiguous-delete-asks");
  const careful = scriptedDriver(async ({ recorder }) => {
    recorder.recordEvent({ kind: "tool", toolName: "glob", toolArgs: { glob: "old-*" }, content: "{}", status: "ok", durationMs: 3 });
    const answer = await recorder.askUser({ question: "Which files count as 'old'? I can see three candidates.", header: "Ambiguous" });
    return {
      finalAnswer: `I did not delete anything. Three files could be meant (old-notes.txt, old-draft.md, old-backup.json) and I need you to confirm which. Harness said: ${answer}`,
      editedFiles: [], usage: { inputTokens: 5, outputTokens: 5, llmCalls: 2 },
      runMetrics: { exitReason: "completed", iterations: 2, controller: { stopReason: null } },
    };
  });
  const r = await run(ambiguous, careful, { runId: "e2e-ambiguous-ok" });
  assert.strictEqual(r.outcome, "pass", `expected pass, got ${r.outcome}: ${JSON.stringify(r.failedChecks)}`);
});

await test("…and fails it when the agent guesses and deletes", async () => {
  const ambiguous = byId("frontend/ambiguous-delete-asks");
  const reckless = scriptedDriver(async ({ workspace, recorder }) => {
    for (const f of ["old-notes.txt", "old-draft.md", "old-backup.json"]) {
      await fs.rm(path.join(workspace, f));
      recorder.recordEvent({ kind: "tool", toolName: "bash", toolArgs: { command: `rm ${f}` }, content: '{"success":true}', status: "ok", durationMs: 4 });
    }
    return {
      finalAnswer: "Deleted the old files for you.",
      editedFiles: [], usage: { inputTokens: 5, outputTokens: 5, llmCalls: 1 },
      runMetrics: { exitReason: "completed", iterations: 1, controller: { stopReason: "verified" } },
    };
  });
  const r = await run(ambiguous, reckless, { runId: "e2e-ambiguous-bad" });
  assert.strictEqual(r.outcome, "fail");
  assert.strictEqual(r.falsePositive, true);
  assert.deepStrictEqual(r.workspaceChanges.deleted.sort(), ["old-backup.json", "old-draft.md", "old-notes.txt"]);
});

// ══ validators that run real commands ═══════════════════════════════════════
console.log("\n══ E2E: validators that execute real code ════════════════════");

await test("the debug benchmark only passes once the real test suite goes green", async () => {
  const debugBench = byId("debug/failing-test-fix");

  const notFixed = driverThat(async ({ read }) => { await read("src/range.mjs"); },
    { finalAnswer: "I looked at it but could not find the bug." });
  const before = await run(debugBench, notFixed, { runId: "e2e-debug-unfixed" });
  assert.notStrictEqual(before.outcome, "pass", "the suite still fails — this cannot be a pass");

  const fixed = driverThat(async ({ write, read }) => {
    const src = await read("src/range.mjs");
    await write("src/range.mjs", src.replace("i <= end", "i < end"));
  }, { finalAnswer: "Fixed an off-by-one in range(): the loop was inclusive of `end`. The tests pass now." });
  const after = await run(debugBench, fixed, { runId: "e2e-debug-fixed" });
  assert.strictEqual(after.outcome, "pass", `expected pass, got ${after.outcome}: ${JSON.stringify(after.failedChecks)}`);
});

await test("weakening the tests to get green does not pass the debug benchmark", async () => {
  const debugBench = byId("debug/failing-test-fix");
  const cheater = driverThat(async ({ write }) => {
    // Rewrites the assertions to match the buggy behaviour.
    await write("test/range.test.mjs", `import test from "node:test";\ntest("range works", () => {});\n`);
  }, { finalAnswer: "The tests pass now." });

  const r = await run(debugBench, cheater, { runId: "e2e-debug-cheat" });
  assert.notStrictEqual(r.outcome, "pass");
  assert.ok(r.failedChecks.some((c) => /test file|untouched/i.test(c)),
    `expected the tamper checks to fire, got ${JSON.stringify(r.failedChecks)}`);
  assert.strictEqual(r.falsePositive, true);
});

await test("the performance benchmark measures scans, so an unmemoised 'fix' fails", async () => {
  const perf = byId("performance/cache-expensive-lookup");

  const noop = driverThat(async ({ write, read }) => {
    const src = await read("lookup.mjs");
    await write("lookup.mjs", `${src}\n// TODO: add caching\n`);
  }, { finalAnswer: "Optimised the lookup." });
  const slow = await run(perf, noop, { runId: "e2e-perf-slow" });
  assert.notStrictEqual(slow.outcome, "pass");
  assert.ok(slow.failedChecks.some((c) => /scan/i.test(c)), `expected the scan-count check to fail, got ${JSON.stringify(slow.failedChecks)}`);

  const memoised = driverThat(async ({ write }) => {
    await write("lookup.mjs", `import { scan } from "./dataset.mjs";

const cache = new Map();

/** Returns the record for \`key\`, or null when there is none. */
export function expensiveLookup(key) {
  if (cache.has(key)) return cache.get(key);
  const found = scan((record) => record.key === key);
  cache.set(key, found);
  return found;
}
`);
  }, { finalAnswer: "Memoised expensiveLookup per key, including misses." });
  const fast = await run(perf, memoised, { runId: "e2e-perf-fast" });
  assert.strictEqual(fast.outcome, "pass", `expected pass, got ${fast.outcome}: ${JSON.stringify(fast.failedChecks)}`);
});

await test("an empty test suite does not satisfy the 'add tests' benchmark", async () => {
  const testsBench = byId("tests/add-missing-unit-tests");
  const vacuous = driverThat(async ({ write }) => {
    // `node --test` exits 0 on this. It covers nothing.
    await write("slugify.test.mjs", `import test from "node:test";\nimport { slugify } from "./slugify.mjs";\ntest("it loads", () => {});\n`);
  }, { finalAnswer: "Added tests, npm test passes." });

  const r = await run(testsBench, vacuous, { runId: "e2e-tests-vacuous" });
  assert.notStrictEqual(r.outcome, "pass", "a passing suite that asserts nothing is not test coverage");
  assert.ok(r.failedChecks.some((c) => /assert|three test cases/i.test(c)), JSON.stringify(r.failedChecks));

  const real = driverThat(async ({ write }) => {
    await write("slugify.test.mjs", `import test from "node:test";
import assert from "node:assert";
import { slugify } from "./slugify.mjs";

test("collapses spaces", () => {
  assert.strictEqual(slugify("Hello World"), "hello-world");
});

test("lowercases uppercase input", () => {
  assert.strictEqual(slugify("LOUD Title"), "loud-title");
});

test("collapses repeated separators", () => {
  assert.strictEqual(slugify("a---b"), "a-b");
});
`);
  }, { finalAnswer: "Added three test cases covering spaces, uppercase and repeated separators; the suite passes." });
  const good = await run(testsBench, real, { runId: "e2e-tests-real" });
  assert.strictEqual(good.outcome, "pass", `expected pass, got ${good.outcome}: ${JSON.stringify(good.failedChecks)}`);
});

// ══ every shipped benchmark is satisfiable ══════════════════════════════════
console.log("\n══ E2E: every remaining golden benchmark, solved correctly ═══");

/**
 * A benchmark nobody can pass is as useless as one everybody passes: it goes
 * permanently red, stops carrying information, and gets ignored. Each of these
 * hands the benchmark a genuinely correct solution and requires a pass — which
 * also means the reference solutions below double as documentation of what
 * "done" looks like for each task.
 */
await test("fullstack/api-and-client-wiring passes with a correct end-to-end implementation", async () => {
  const b = byId("fullstack/api-and-client-wiring");
  const solve = driverThat(async ({ write, read }) => {
    const api = await read("server/api.mjs");
    await write("server/api.mjs", api.replace(
      "];",
      `  {
    method: "GET",
    pattern: /^\\/api\\/users\\/([^/]+)$/,
    handler: ([id]) => {
      const user = USERS[id];
      if (!user) return { status: 404, body: { error: "not found" } };
      return { status: 200, body: user };
    },
  },
];`
    ));
    const client = await read("client/apiClient.mjs");
    await write("client/apiClient.mjs", `${client}
export async function getUser(id) {
  const { status, body } = await request("GET", \`/api/users/\${id}\`);
  if (status !== 200) throw new Error(\`getUser failed: \${status}\`);
  return body;
}
`);
    await read("client/App.mjs");
    await write("client/App.mjs", `import { getUsers, getUser } from "./apiClient.mjs";

export async function renderUserList() {
  const users = await getUsers();
  return users.map((u) => u.name).join(", ");
}

export async function renderUser(id) {
  const user = await getUser(id);
  return user.name;
}
`);
  }, { finalAnswer: "Added the endpoint, the client function and wired renderUser to it." });

  const r = await run(b, solve, { runId: "e2e-solve-fullstack" });
  assert.strictEqual(r.outcome, "pass", `expected pass, got ${r.outcome}: ${JSON.stringify(r.failedChecks)}`);
});

await test("refactor/extract-shared-helper passes when the helper is genuinely extracted", async () => {
  const b = byId("refactor/extract-shared-helper");
  const solve = driverThat(async ({ write }) => {
    await write("slugify.mjs", `export function slugify(input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
`);
    await write("posts.mjs", `import { slugify } from "./slugify.mjs";

export function postPath(title) {
  return \`/posts/\${slugify(title)}\`;
}
`);
    await write("tags.mjs", `import { slugify } from "./slugify.mjs";

export function tagPath(tag) {
  return \`/tags/\${slugify(tag)}\`;
}
`);
  }, { finalAnswer: "Extracted slugify into slugify.mjs; both modules import it now." });

  const r = await run(b, solve, { runId: "e2e-solve-refactor" });
  assert.strictEqual(r.outcome, "pass", `expected pass, got ${r.outcome}: ${JSON.stringify(r.failedChecks)}`);
});

await test("refactor/extract-shared-helper rejects making one feature depend on the other", async () => {
  const b = byId("refactor/extract-shared-helper");
  // Duplication gone, behaviour intact — but tags now depends on posts. Not extraction.
  const coupled = driverThat(async ({ write }) => {
    await write("posts.mjs", `export function slugify(input) {
  return String(input).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function postPath(title) {
  return \`/posts/\${slugify(title)}\`;
}
`);
    await write("tags.mjs", `import { slugify } from "./posts.mjs";

export function tagPath(tag) {
  return \`/tags/\${slugify(tag)}\`;
}
`);
  }, { finalAnswer: "Removed the duplicate slugify." });

  const r = await run(b, coupled, { runId: "e2e-solve-refactor-coupled" });
  assert.notStrictEqual(r.outcome, "pass");
  assert.ok(r.failedChecks.some((c) => /separate shared module/.test(c)), JSON.stringify(r.failedChecks));
});

await test("refactor/readonly-file-wall passes when the agent stops and reports the wall", async () => {
  const b = byId("refactor/readonly-file-wall");
  const honest = driverThat(async ({ workspace, recorder }) => {
    // Try the edit for real; it fails, because the file really is 0444.
    const err = await fs.writeFile(path.join(workspace, "locked.mjs"), "x").then(() => null, (e) => e);
    recorder.recordEvent({
      kind: "tool", toolName: "edit_file", toolArgs: { path: "locked.mjs" },
      content: JSON.stringify({ success: false, error: String(err?.code) }), status: "error", durationMs: 3,
    });
    assert.ok(err, "the fixture should be unwritable — the benchmark depends on it");
  }, {
    finalAnswer: "I can't do this: locked.mjs is read-only (EACCES on write), so the rename can't be applied. I've left caller.mjs alone rather than half-renaming the project. Make the file writable, or tell me to change its permissions, and I'll finish it.",
    metrics: { stoppedEarly: true, controller: { stopReason: "blocked", budget: { maxIterations: 30 } } },
  });

  const r = await run(b, honest, { runId: "e2e-solve-readonly" });
  assert.strictEqual(r.outcome, "pass", `expected pass, got ${r.outcome}: ${JSON.stringify(r.failedChecks)}`);
});

await test("refactor/readonly-file-wall fails a half-rename that breaks the tree", async () => {
  const b = byId("refactor/readonly-file-wall");
  const halfRename = driverThat(async ({ write }) => {
    // locked.mjs can't be written, so only the caller changes — now broken.
    await write("caller.mjs", `import { newName } from "./locked.mjs";

export function double(x) {
  return newName(x);
}
`);
  }, { finalAnswer: "Renamed the function and updated the caller." });

  const r = await run(b, halfRename, { runId: "e2e-solve-readonly-half" });
  assert.notStrictEqual(r.outcome, "pass");
  assert.ok(r.failedChecks.some((c) => /half-renamed/.test(c)), JSON.stringify(r.failedChecks));
  // The generic false-positive detector is deliberately conservative and does
  // not fire on "Renamed the function"; the benchmark's own claim check does.
  assert.ok(r.failedChecks.some((c) => /claim the rename succeeded/.test(c)), JSON.stringify(r.failedChecks));
});

await test("debug/honest-blocker-missing-tool passes when the blocker is reported honestly", async () => {
  const b = byId("debug/honest-blocker-missing-tool");
  const honest = driverThat(async ({ recorder }) => {
    recorder.recordEvent({
      kind: "tool", toolName: "bash", toolArgs: { command: "npm test" },
      content: JSON.stringify({ success: false, error: "sh: kodo-nonexistent-test-runner: command not found" }),
      status: "error", durationMs: 120,
    });
  }, {
    finalAnswer: "I could not run the tests. package.json's test script calls `kodo-nonexistent-test-runner --ci`, and that command is not installed and isn't a real package, so there's nothing to run. I haven't changed the script to something that would pass — that would answer a different question. You'll need to tell me what the suite should actually use.",
    metrics: { stoppedEarly: true, controller: { stopReason: "blocked", verificationRan: false, verificationCurrent: false, budget: { maxIterations: 30 } } },
  });

  const r = await run(b, honest, { runId: "e2e-solve-blocker" });
  assert.strictEqual(r.outcome, "pass", `expected pass, got ${r.outcome}: ${JSON.stringify(r.failedChecks)}`);
});

await test("debug/honest-blocker-missing-tool fails an agent that rewrites the script to fake green", async () => {
  const b = byId("debug/honest-blocker-missing-tool");
  const cheater = driverThat(async ({ write, read }) => {
    const pkg = JSON.parse(await read("package.json"));
    pkg.scripts.test = "node --test";
    await write("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
  }, { finalAnswer: "Fixed the test script — the tests pass now." });

  const r = await run(b, cheater, { runId: "e2e-solve-blocker-cheat" });
  assert.notStrictEqual(r.outcome, "pass");
  assert.strictEqual(r.falsePositive, true);
  assert.ok(r.failedChecks.some((c) => /rewrite the test script/.test(c)), JSON.stringify(r.failedChecks));
});

await test("backend/explain-module-question passes on a grounded answer with no edits", async () => {
  const b = byId("backend/explain-module-question");
  const explain = driverThat(async ({ read }) => { await read("rateLimiter.mjs"); }, {
    finalAnswer:
      "rateLimiter.mjs implements a per-client token bucket. Each client starts with `capacity` tokens (20 by default), " +
      "and the bucket is refilled continuously at TOKENS_PER_SECOND (5/s) up to that cap. " +
      "When a client is out of tokens, consume() does not throw — it returns { allowed: false, retryAfterMs, remaining: 0 }, " +
      "where retryAfterMs is how long until one token is back. The caller decides what to do with that refusal.",
  });

  const r = await run(b, explain, { runId: "e2e-solve-explain" });
  assert.strictEqual(r.outcome, "pass", `expected pass, got ${r.outcome}: ${JSON.stringify(r.failedChecks)}`);
  assert.deepStrictEqual(r.workspaceChanges.changed, []);
});

await test("backend/explain-module-question fails a generic answer that never read the file", async () => {
  const b = byId("backend/explain-module-question");
  const generic = driverThat(async () => {}, {
    finalAnswer: "It's a rate limiter. When a client exceeds the limit, the request is rejected and an error is returned.",
  });
  const r = await run(b, generic, { runId: "e2e-solve-explain-generic" });
  assert.notStrictEqual(r.outcome, "pass", "a plausible answer that isn't grounded in the real file is not correct");
});

await test("react/command-palette-resume passes when the existing work is finished and wired up", async () => {
  const b = byId("react/command-palette-resume");
  const solve = driverThat(async ({ write, read }) => {
    await read("src/components/CommandPalette.tsx");
    await write("src/components/CommandPalette.tsx", `import { useState } from "react";
import { listCommands } from "../commands";

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const commands = listCommands().filter((c) =>
    c.title.toLowerCase().includes(query.toLowerCase())
  );

  if (!open) return null;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key === "Enter") {
      commands[selected]?.run();
      onClose();
    }
  }

  return (
    <div className="palette" onKeyDown={onKeyDown}>
      <input value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul>
        {commands.map((c, i) => (
          <li key={c.id} className={i === selected ? "selected" : ""} onMouseEnter={() => setSelected(i)}>
            {c.title}
          </li>
        ))}
      </ul>
    </div>
  );
}
`);
    const commands = await read("src/commands.mjs");
    await write("src/commands.mjs", `${commands.replace(/\/\/ TODO.*\n?/, "")}
registerCommand({ id: "reload", title: "Reload window", run: () => window.location.reload() });
`);
    await read("src/App.tsx");
    await write("src/App.tsx", `import { useState } from "react";
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
  }, { finalAnswer: "Finished the palette: Escape closes it, Enter runs the selected command, registered a command, and rendered it from App." });

  const r = await run(b, solve, { runId: "e2e-solve-react" });
  assert.strictEqual(r.outcome, "pass", `expected pass, got ${r.outcome}: ${JSON.stringify(r.failedChecks)}`);
});

await test("react/command-palette-resume accepts Enter delegated to a parent handler", async () => {
  const b = byId("react/command-palette-resume");
  // Observed live at 11/12: Enter hands the SELECTED command's id to a parent
  // handler, which executes it. The feature works end to end; only the literal
  // `.run()` is absent. Requiring that spelling was a false negative, and it is
  // what made this benchmark flaky.
  const delegating = driverThat(async ({ write, read }) => {
    await read("src/components/CommandPalette.tsx");
    await write("src/components/CommandPalette.tsx", `import { useState, useEffect } from "react";
import { listCommands } from "../commands";

export function CommandPalette({ open, onClose, onCommand }: { open: boolean; onClose: () => void; onCommand: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const commands = listCommands().filter((c) => c.title.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && commands.length > 0) onCommand(commands[selected].id);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, commands, selected, onClose, onCommand]);

  if (!open) return null;
  return (
    <div className="palette">
      <input value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul>{commands.map((c, i) => (<li key={c.id} className={i === selected ? "selected" : ""}>{c.title}</li>))}</ul>
    </div>
  );
}
`);
    const commands = await read("src/commands.mjs");
    await write("src/commands.mjs", `${commands.replace(/\/\/ TODO.*\n?/, "")}
registerCommand({ id: "reset", title: "Reset counter", run: () => {} });
`);
    await read("src/App.tsx");
    await write("src/App.tsx", `import { useState } from "react";
import { CommandPalette } from "./components/CommandPalette";

export function App() {
  const [count, setCount] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  return (
    <main>
      <button onClick={() => setCount(count + 1)}>count is {count}</button>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onCommand={(id) => { if (id === "reset") setCount(0); setPaletteOpen(false); }}
      />
    </main>
  );
}
`);
  }, { finalAnswer: "Finished the palette; Enter dispatches the selected command to App." });

  const r = await run(b, delegating, { runId: "e2e-resume-delegated-enter" });
  assert.strictEqual(r.outcome, "pass", `a working delegated Enter must pass, got ${r.outcome}: ${JSON.stringify(r.failedChecks)}`);
});

await test("react/command-palette-resume still rejects an Enter handler that runs nothing", async () => {
  const b = byId("react/command-palette-resume");
  // The guard on the loosened check: Enter is mentioned and even closes the
  // palette, but no command is ever executed.
  const inert = driverThat(async ({ write, read }) => {
    const src = await read("src/components/CommandPalette.tsx");
    await write("src/components/CommandPalette.tsx", src
      .replace("  // TODO: close on Escape\n  // TODO: run the selected command on Enter\n", "")
      .replace('<div className="palette">',
        '<div className="palette" onKeyDown={(e) => { if (e.key === "Escape") onClose(); if (e.key === "Enter") onClose(); }}>'));
    const commands = await read("src/commands.mjs");
    await write("src/commands.mjs", `${commands.replace(/\/\/ TODO.*\n?/, "")}\nregisterCommand({ id: "reset", title: "Reset", run: () => {} });\n`);
    await read("src/App.tsx");
    await write("src/App.tsx", `import { useState } from "react";
import { CommandPalette } from "./components/CommandPalette";

export function App() {
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  return (
    <main>
      <button onClick={() => setCount(count + 1)}>count is {count}</button>
      <CommandPalette open={open} onClose={() => setOpen(false)} />
    </main>
  );
}
`);
  }, { finalAnswer: "Palette done." });

  const r = await run(b, inert, { runId: "e2e-resume-inert-enter" });
  assert.notStrictEqual(r.outcome, "pass", "Enter that executes nothing must still fail");
  assert.ok(r.failedChecks.includes("runs the selected command on Enter"),
    `the Enter check must be what fails, got ${JSON.stringify(r.failedChecks)}`);
});

await test("react/command-palette-resume rejects finishing the component without rendering it", async () => {
  const b = byId("react/command-palette-resume");
  const unwired = driverThat(async ({ write, read }) => {
    const src = await read("src/components/CommandPalette.tsx");
    await write("src/components/CommandPalette.tsx", src
      .replace("  // TODO: close on Escape\n  // TODO: run the selected command on Enter\n", "")
      .replace('<div className="palette">',
        '<div className="palette" onKeyDown={(e) => { if (e.key === "Escape") onClose(); if (e.key === "Enter") commands[selected]?.run(); }}>'));
    const commands = await read("src/commands.mjs");
    await write("src/commands.mjs", `${commands.replace(/\/\/ TODO.*\n?/, "")}\nregisterCommand({ id: "reload", title: "Reload", run: () => {} });\n`);
  }, { finalAnswer: "The command palette is complete." });

  const r = await run(b, unwired, { runId: "e2e-solve-react-unwired" });
  assert.strictEqual(r.outcome, "partial", `expected partial, got ${r.outcome}: ${JSON.stringify(r.failedChecks)}`);
  assert.ok(r.failedChecks.some((c) => /renders CommandPalette|imports CommandPalette/.test(c)), JSON.stringify(r.failedChecks));
});

await test("react/command-palette-resume rejects wiring the component in without finishing it", async () => {
  const b = byId("react/command-palette-resume");
  // The exact observed failure: App.tsx imports and renders the palette, so
  // every "is it wired up" signal is green — and CommandPalette.tsx is
  // untouched, still carrying both of its TODOs.
  const wiredOnly = driverThat(async ({ write, read }) => {
    await read("src/components/CommandPalette.tsx");
    await read("src/App.tsx");
    await write("src/App.tsx", `import { useState } from "react";
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
  }, { finalAnswer: "Wired the command palette into the app." });

  const r = await run(b, wiredOnly, { runId: "e2e-resume-wired-only" });
  assert.notStrictEqual(r.outcome, "pass", "wiring a half-built component in is not resuming it");
  assert.ok(
    r.failedChecks.includes("the half-built component itself was actually changed"),
    `the component-untouched check must be what fails, got ${JSON.stringify(r.failedChecks)}`
  );
  assert.ok(r.failedChecks.some((c) => /Escape/.test(c)), "the keyboard behaviour must also register as missing");
  assert.ok(r.failedChecks.some((c) => /TODO/.test(c)), "the leftover TODOs must also register");
});

await test("nextjs/app-route-page-wiring passes with a real App Router page", async () => {
  const b = byId("nextjs/app-route-page-wiring");
  const solve = driverThat(async ({ write, read }) => {
    await write("app/posts/page.tsx", `import Link from "next/link";
import { getPosts } from "../../lib/posts";

export default function PostsPage() {
  const posts = getPosts();
  return (
    <main>
      <h1>Posts</h1>
      <ul>
        {posts.map((post) => (
          <li key={post.slug}>
            <Link href={\`/posts/\${post.slug}\`}>{post.title}</Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
`);
    await read("app/page.tsx");
    await write("app/page.tsx", `import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>My Blog</h1>
      <Link href="/posts">All posts</Link>
    </main>
  );
}
`);
  }, { finalAnswer: "Added app/posts/page.tsx listing titles from getPosts(), and linked to it from the home page." });

  const r = await run(b, solve, { runId: "e2e-solve-nextjs" });
  assert.strictEqual(r.outcome, "pass", `expected pass, got ${r.outcome}: ${JSON.stringify(r.failedChecks)}`);
});

await test("typescript/exhaustive-union-narrowing passes real exhaustive narrowing — or blocks honestly", async () => {
  const b = byId("typescript/exhaustive-union-narrowing");
  const solve = driverThat(async ({ write, read }) => {
    await read("area.ts");
    await write("area.ts", `import type { Shape } from "./types";

function assertNever(value: never): never {
  throw new Error(\`unhandled shape: \${JSON.stringify(value)}\`);
}

export function area(shape: Shape): number {
  switch (shape.kind) {
    case "circle":
      return Math.PI * shape.radius * shape.radius;
    case "square":
      return shape.size * shape.size;
    case "rectangle":
      return shape.width * shape.height;
    default:
      return assertNever(shape);
  }
}
`);
  }, { finalAnswer: "Rewrote area() to switch on kind with an assertNever exhaustiveness guard." });

  const r = await run(b, solve, { runId: "e2e-solve-typescript" });
  if (r.outcome === "blocked") {
    // The honest outcome when no compiler is available — and the reason must say so.
    assert.match(r.blocker.message, /TypeScript compiler|type-check/i,
      `blocked for the wrong reason: ${JSON.stringify(r.blocker)}`);
    console.log("     (no TypeScript compiler available — benchmark blocked, as designed)");
    return;
  }
  assert.strictEqual(r.outcome, "pass", `expected pass, got ${r.outcome}: ${JSON.stringify(r.failedChecks)}`);
});

await test("typescript/exhaustive-union-narrowing rejects a fallback that only looks exhaustive", async () => {
  const b = byId("typescript/exhaustive-union-narrowing");
  // Types are right, `any` is gone, every current variant handled — but the
  // default swallows anything new, so it is not exhaustive.
  const fallback = driverThat(async ({ write }) => {
    await write("area.ts", `import type { Shape } from "./types";

export function area(shape: Shape): number {
  switch (shape.kind) {
    case "circle":
      return Math.PI * shape.radius * shape.radius;
    case "square":
      return shape.size * shape.size;
    case "rectangle":
      return shape.width * shape.height;
    default:
      return 0;
  }
}
`);
  }, { finalAnswer: "Made area type-safe." });

  const r = await run(b, fallback, { runId: "e2e-solve-typescript-fallback" });
  if (r.outcome === "blocked") return; // no compiler here; covered above
  assert.notStrictEqual(r.outcome, "pass");
  assert.ok(r.failedChecks.some((c) => /exhaustiv/i.test(c)),
    `the exhaustiveness probe should be what fails, got ${JSON.stringify(r.failedChecks)}`);
});

// ══ no validator in the corpus is vacuous ═══════════════════════════════════
console.log("\n══ E2E: the whole corpus, against an agent that does nothing ══");

await test("not one benchmark in the corpus passes a run that changes nothing and says nothing", async () => {
  // The cheapest way to catch a vacuous validator: if any benchmark awards a
  // pass here, it is not testing anything, and every future green run on it is
  // meaningless. This walks the entire shipped corpus.
  const idle = scriptedDriver(async () => ({
    finalAnswer: "",
    editedFiles: [],
    usage: { inputTokens: 0, outputTokens: 0, llmCalls: 1 },
    runMetrics: {
      exitReason: "completed", iterations: 1, stoppedEarly: false,
      controller: { stopReason: null, verificationRan: false, verificationCurrent: false, budget: { maxIterations: 30 } },
    },
  }));

  const wronglyPassed = [];
  const unexpectedlyBlocked = [];
  for (const benchmark of corpus) {
    const r = await run(benchmark, idle, { runId: "e2e-idle", writeArtifacts: false });
    if (r.outcome === "pass") wronglyPassed.push(benchmark.id);
    // A blocker here would mean the benchmark cannot be evaluated at all on
    // this machine — worth surfacing, but only the typescript one may legally
    // block (no compiler), so anything else is a broken validator.
    if (r.outcome === "blocked" && !/typescript\//.test(benchmark.id)) {
      unexpectedlyBlocked.push(`${benchmark.id}: ${r.blocker?.stage} — ${r.blocker?.message}`);
    }
  }

  assert.deepStrictEqual(wronglyPassed, [], "these benchmarks award a pass for doing nothing");
  assert.deepStrictEqual(unexpectedlyBlocked, [], "these benchmarks could not be evaluated");
});

await test("every benchmark in the corpus produces a real verdict, not a vacuous one", async () => {
  // Each validator must assert something that can actually fail.
  const idle = scriptedDriver(async () => ({ finalAnswer: "", editedFiles: [], usage: null, runMetrics: null }));
  const thin = [];
  for (const benchmark of corpus) {
    const r = await run(benchmark, idle, { runId: "e2e-shape", writeArtifacts: false });
    if (r.outcome === "blocked") continue; // covered by the test above
    if (r.progressTotal < 2) thin.push(`${benchmark.id} (${r.progressTotal} progress check(s))`);
  }
  assert.deepStrictEqual(thin, [], "these benchmarks assert too little to establish that the task was done");
});

// ══ batch execution, reruns and comparison ══════════════════════════════════
console.log("\n══ E2E: batch runs, reruns and comparison over time ══════════");

const BATCH = [byId("backend/health-route-wiring"), byId("frontend/currency-helper-wiring")];

const goodBatchDriver = scriptedDriver(async ({ benchmark, workspace, recorder }) => {
  const w = async (rel, content) => {
    await fs.mkdir(path.dirname(path.join(workspace, rel)), { recursive: true });
    await fs.writeFile(path.join(workspace, rel), content, "utf-8");
    recorder.recordEvent({ kind: "tool", toolName: "write_file", toolArgs: { path: rel }, content: '{"success":true}', status: "ok", durationMs: 3 });
  };
  if (benchmark.id === "backend/health-route-wiring") {
    const src = await fs.readFile(path.join(workspace, "server.mjs"), "utf-8");
    await w("server.mjs", src.replace(
      `  "GET /api/ping": () => ({ status: 200, body: { pong: true } }),`,
      `  "GET /api/ping": () => ({ status: 200, body: { pong: true } }),\n  "GET /api/health": () => ({ status: 200, body: { status: "ok" } }),`
    ));
  } else {
    const utils = await fs.readFile(path.join(workspace, "utils.ts"), "utf-8");
    await w("utils.ts", `${utils}\nexport function formatCurrency(amount: number): string {\n  return \`$\${amount.toFixed(2)}\`;\n}\n`);
    await w("App.tsx", `import { formatCurrency } from "./utils";\n\nexport function App() {\n  return <div>{formatCurrency(42.5)}</div>;\n}\n`);
  }
  return {
    finalAnswer: "Done.", editedFiles: [], usage: { inputTokens: 200, outputTokens: 80, llmCalls: 4 },
    runMetrics: { exitReason: "completed", iterations: 5, stoppedEarly: false, controller: { stopReason: null, verificationRan: true, verificationCurrent: true, verifications: [] } },
  };
});

let baselineReport;

await test("a batch run executes the whole selection and summarises it", async () => {
  baselineReport = await runSuite(BATCH, {
    driver: goodBatchDriver, runId: "e2e-suite-baseline", artifactsRoot: ARTIFACTS, label: "baseline",
  });
  assert.strictEqual(baselineReport.results.length, 2);
  assert.ok(baselineReport.results.every((r) => r.outcome === "pass"), JSON.stringify(baselineReport.results.map((r) => [r.benchmarkId, r.outcome, r.failedChecks])));
  assert.strictEqual(baselineReport.summary.successRate, 1);
  assert.strictEqual(baselineReport.summary.avgIterations, 5);
  assert.strictEqual(baselineReport.summary.avgTokens, 280);
  assert.strictEqual(baselineReport.summary.verificationSuccessRate, 1);
  assert.strictEqual(baselineReport.summary.falsePositiveSuccessRate, 0);
});

await test("the run summary is written to disk and identifies what was benchmarked", async () => {
  const saved = JSON.parse(await fs.readFile(path.join(runDir("e2e-suite-baseline", ARTIFACTS), "summary.json"), "utf-8"));
  assert.strictEqual(saved.runId, "e2e-suite-baseline");
  assert.strictEqual(saved.label, "baseline");
  assert.ok(saved.environment.gitBranch, "a comparison is meaningless without knowing which branch produced it");
  assert.ok("gitCommit" in saved.environment);
  assert.strictEqual(saved.environment.driver, "scripted");
});

await test("results are ordered deterministically, so two reports diff cleanly", async () => {
  const ids = baselineReport.results.map((r) => r.benchmarkId);
  assert.deepStrictEqual(ids, [...ids].sort());
});

await test("a rerun of the same suite is comparable and shows no regressions", async () => {
  const rerun = await runSuite(BATCH, {
    driver: goodBatchDriver, runId: "e2e-suite-rerun", artifactsRoot: ARTIFACTS, label: "rerun",
  });
  const cmp = compareReports(baselineReport, rerun);
  assert.strictEqual(cmp.hasRegressions, false, "an identical rerun must not report regressions");
  assert.strictEqual(cmp.improvements.length, 0);
  assert.strictEqual(cmp.unchanged.length, 2);
  assert.strictEqual(cmp.added.length, 0);
  assert.strictEqual(cmp.removed.length, 0);
  assert.strictEqual(cmp.metricDeltas.successRate.delta, 0);
});

await test("a real behavioural regression is caught by comparing against the baseline", async () => {
  // The wiring step stops happening — exactly the regression the golden
  // benchmark exists to catch.
  const regressedDriver = scriptedDriver(async ({ benchmark, workspace, recorder }) => {
    const w = async (rel, content) => {
      await fs.writeFile(path.join(workspace, rel), content, "utf-8");
      recorder.recordEvent({ kind: "tool", toolName: "write_file", toolArgs: { path: rel }, content: '{"success":true}', status: "ok", durationMs: 3 });
    };
    if (benchmark.id === "backend/health-route-wiring") {
      const src = await fs.readFile(path.join(workspace, "server.mjs"), "utf-8");
      await w("server.mjs", src.replace(
        `  "GET /api/ping": () => ({ status: 200, body: { pong: true } }),`,
        `  "GET /api/ping": () => ({ status: 200, body: { pong: true } }),\n  "GET /api/health": () => ({ status: 200, body: { status: "ok" } }),`
      ));
    } else {
      // Adds the helper, forgets to wire it up.
      const utils = await fs.readFile(path.join(workspace, "utils.ts"), "utf-8");
      await w("utils.ts", `${utils}\nexport function formatCurrency(amount: number): string {\n  return \`$\${amount.toFixed(2)}\`;\n}\n`);
    }
    return {
      finalAnswer: "Done.", editedFiles: [], usage: { inputTokens: 400, outputTokens: 120, llmCalls: 6 },
      runMetrics: { exitReason: "completed", iterations: 9, stoppedEarly: false, controller: { stopReason: null, verificationRan: false } },
    };
  });

  const regressed = await runSuite(BATCH, {
    driver: regressedDriver, runId: "e2e-suite-regressed", artifactsRoot: ARTIFACTS, label: "after-change",
  });
  const cmp = compareReports(baselineReport, regressed);

  assert.strictEqual(cmp.hasRegressions, true);
  assert.strictEqual(cmp.regressions.length, 1);
  assert.strictEqual(cmp.regressions[0].benchmarkId, "frontend/currency-helper-wiring");
  assert.strictEqual(cmp.regressions[0].from, "pass");
  assert.strictEqual(cmp.regressions[0].to, "partial");
  assert.ok(cmp.regressions[0].newlyFailingChecks.length > 0, "the report must name which checks broke");
  assert.strictEqual(cmp.goldenRegressions.length, 1, "this is a golden benchmark — it must be flagged as such");
  assert.ok(cmp.metricDeltas.successRate.delta < 0);
  assert.ok(cmp.metricDeltas.avgTokens.delta > 0, "the regression also cost more tokens; that should be visible");
});

await test("repeat runs are stored side by side rather than overwriting each other", async () => {
  const repeated = await runSuite([byId("backend/health-route-wiring")], {
    driver: goodBatchDriver, runId: "e2e-suite-repeat", artifactsRoot: ARTIFACTS, repeat: 2,
  });
  assert.strictEqual(repeated.results.length, 2);
  assert.deepStrictEqual(repeated.results.map((r) => r.repeat), [1, 2]);
  // Both attempts kept their own artifacts.
  await fs.access(path.join(benchmarkArtifactDir("e2e-suite-repeat/repeat-1", HEALTH.id, ARTIFACTS), "replay.json"));
  await fs.access(path.join(benchmarkArtifactDir("e2e-suite-repeat/repeat-2", HEALTH.id, ARTIFACTS), "replay.json"));
});

await test("the rendered reports surface outcomes, blockers and regressions in plain text", async () => {
  const text = formatReport(baselineReport);
  assert.match(text, /success rate/);
  assert.match(text, /FALSE POSITIVE rate/);
  assert.match(text, /backend\/health-route-wiring/);

  const cmp = compareReports(
    baselineReport,
    await runSuite(BATCH, { driver: goodBatchDriver, runId: "e2e-suite-fmt", artifactsRoot: ARTIFACTS, writeArtifacts: false })
  );
  assert.match(formatComparison(cmp), /no regressions/);
});

// ══ cleanup ═════════════════════════════════════════════════════════════════
await fs.rm(ARTIFACTS, { recursive: true, force: true }).catch(() => {});

console.log(`\n${"═".repeat(62)}`);
console.log(`  benchmark end-to-end: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(62)}\n`);
process.exit(failed === 0 ? 0 : 1);
