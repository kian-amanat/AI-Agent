/**
 * tests/provider-errors.test.mjs
 * Run with: node tests/provider-errors.test.mjs
 *
 * A provider failure must never look like success.
 *
 * This matters more than it sounds. `kodo run` is built for CI and for other
 * agents; if a quota error, an expired key or a rejected model produced exit 0
 * and a plausible-looking transcript, an automated caller would treat "the
 * model never ran" as "the task is done" and carry on. That is a silent
 * data-integrity failure, not a cosmetic one.
 *
 * Deliberately driven by a LOCAL fake provider rather than the real one:
 *
 *   - it exercises the paths that a real provider only produces when something
 *     has gone wrong (quota exhaustion, revoked key, unknown model), which are
 *     exactly the ones you cannot summon on demand from a healthy account;
 *   - it stays deterministic and free, so this is a permanent regression test
 *     rather than a thing that only runs when the billing gods allow.
 *
 * The live suites (mcpLiveE2E, subagentLiveE2E) remain the proof that the happy
 * path works against a real model. This file is the proof that the UNhappy path
 * is reported honestly.
 */

import fs from "fs";
import http from "http";
import path from "path";

import { assert, test, section, finish, runCli, withTempHome, tempWorkspace } from "./harness.mjs";
import { EXIT } from "../src/exit.mjs";

/** A provider that always fails, in a specified way. */
async function failingProvider({ status, body }) {
  const server = http.createServer((req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() { await new Promise((r) => server.close(r)); },
  };
}

function configure(home, baseUrl) {
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    model: "test-model",
    apiKey: "sk-test-key-not-real",
    baseUrl,
  }));
}

/**
 * Run a task against a failing provider and return the outcome.
 * Credentials are pinned to the fake so a real .env cannot rescue the run.
 */
async function runAgainst(home, provider, extraArgs = []) {
  const ws = tempWorkspace({ "a.txt": "hello\n" });
  try {
    configure(home, provider.baseUrl);
    const r = await runCli(["run", "say hello", "--cwd", ws, ...extraArgs], {
      home,
      env: {
        OPENAI_API_KEY: "sk-test-key-not-real",
        OPENAI_BASE_URL: provider.baseUrl,
        DEFAULT_MODEL: "test-model",
      },
      timeoutMs: 180_000,
    });
    return r;
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

const SCENARIOS = [
  {
    name: "quota exhausted",
    status: 403,
    body: { error: { message: "pre-consume quota failed, remaining user quota: $0.0004", code: "insufficient_user_quota", type: "gap_api_error" } },
  },
  {
    name: "invalid API key",
    status: 401,
    body: { error: { message: "Incorrect API key provided", code: "invalid_api_key", type: "invalid_request_error" } },
  },
  {
    name: "model rejected",
    status: 404,
    body: { error: { message: "The model 'test-model' does not exist", code: "model_not_found", type: "invalid_request_error" } },
  },
  {
    name: "rate limited",
    status: 429,
    body: { error: { message: "Rate limit reached", code: "rate_limit_exceeded", type: "rate_limit_error" } },
  },
  {
    name: "provider 500",
    status: 500,
    body: { error: { message: "internal server error" } },
  },
];

section("provider failures never look like success");

for (const scenario of SCENARIOS) {
  await test(`${scenario.name}: exits non-zero`, withTempHome(async (home) => {
    const provider = await failingProvider(scenario);
    try {
      const r = await runAgainst(home, provider);
      assert.notStrictEqual(r.code, EXIT.OK,
        `a ${scenario.name} must not exit 0 — a CI caller would read that as "task done"`);
      assert.ok(!r.timedOut, "it must fail promptly rather than hanging");
    } finally {
      await provider.close();
    }
  }));
}

await test("an auth failure is reported as AUTH (4), distinguishable from a failed task", withTempHome(async (home) => {
  const provider = await failingProvider(SCENARIOS[1]);   // 401
  try {
    const r = await runAgainst(home, provider);
    assert.strictEqual(r.code, EXIT.AUTH,
      `an invalid key should exit ${EXIT.AUTH} (auth), not ${r.code} — ` +
      "a caller needs to tell 'your credential is wrong' apart from 'the agent tried and failed'");
  } finally {
    await provider.close();
  }
}));

await test("--json never reports success:true when the provider failed", withTempHome(async (home) => {
  const provider = await failingProvider(SCENARIOS[0]);   // quota
  try {
    const r = await runAgainst(home, provider, ["--json"]);
    assert.notStrictEqual(r.code, EXIT.OK);

    // Every stdout line must still be valid JSON — a failure must not corrupt
    // the machine-readable stream with a stack trace or a banner.
    const lines = r.stdout.split("\n").filter(Boolean);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line),
        `--json emitted a non-JSON line on the failure path: ${line.slice(0, 120)}`);
    }

    const events = lines.map((l) => JSON.parse(l));
    const completed = events.find((e) => e.type === "session_completed");
    if (completed) {
      assert.notStrictEqual(completed.success, true,
        "session_completed reported success:true even though the provider rejected every call");
    }
  } finally {
    await provider.close();
  }
}));

await test("the provider's own reason reaches the user, not a generic message", withTempHome(async (home) => {
  const provider = await failingProvider(SCENARIOS[0]);   // quota
  try {
    const r = await runAgainst(home, provider);
    const said = `${r.stderr}${r.stdout}`;
    assert.ok(/quota/i.test(said),
      "the quota reason must survive to the user — 'something went wrong' sends people to the wrong problem");
  } finally {
    await provider.close();
  }
}));

await test("a credential is never echoed on a failure path", withTempHome(async (home) => {
  const provider = await failingProvider(SCENARIOS[1]);
  try {
    const r = await runAgainst(home, provider);
    assert.ok(!`${r.stdout}${r.stderr}`.includes("sk-test-key-not-real"),
      "the API key appeared in output on the error path — errors are exactly where keys tend to leak");
  } finally {
    await provider.close();
  }
}));

finish();
