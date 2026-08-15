/**
 * tests/cli.test.mjs
 * Run with: node tests/cli.test.mjs
 *
 * The command surface: parsing, exit codes, stream separation, and the promise
 * that a broken/unconfigured installation still gets useful output instead of a
 * stack trace. These run as real subprocesses and make no network calls.
 */

import fs from "fs";
import path from "path";

import { assert, test, section, finish, runCli, withTempHome, tempWorkspace } from "./harness.mjs";
import { parseArgs } from "../src/args.mjs";
import { EXIT } from "../src/exit.mjs";
import { isSecretKey, maskSecret, redact, flatten, coerceValue, resolveConfig } from "../src/config.mjs";

// ── Argument parsing ─────────────────────────────────────────────────────────

section("parseArgs");

await test("--key value, --key=value and -k value all parse", () => {
  const spec = { port: { type: "number", short: "p" }, host: { type: "string" } };
  assert.strictEqual(parseArgs(["--port", "3000"], spec).flags.port, 3000);
  assert.strictEqual(parseArgs(["--port=3000"], spec).flags.port, 3000);
  assert.strictEqual(parseArgs(["-p", "3000"], spec).flags.port, 3000);
  assert.strictEqual(parseArgs(["--host", "0.0.0.0"], spec).flags.host, "0.0.0.0");
});

await test("--port 0 survives (it means 'pick a free port', not 'unset')", () => {
  const { flags } = parseArgs(["--port", "0"], { port: { type: "number" } });
  assert.strictEqual(flags.port, 0);
});

await test("booleans support --flag and --no-flag", () => {
  const spec = { detach: { type: "boolean" }, color: { type: "boolean", default: true } };
  assert.strictEqual(parseArgs(["--detach"], spec).flags.detach, true);
  assert.strictEqual(parseArgs(["--no-color"], spec).flags.color, false);
  assert.strictEqual(parseArgs([], spec).flags.color, true);
});

await test("an unknown option is an error, not silently ignored", () => {
  assert.throws(() => parseArgs(["--nonsense"], { real: { type: "string" } }), /Unknown option/);
});

await test("a value-taking option with no value is an error", () => {
  assert.throws(() => parseArgs(["--host"], { host: { type: "string" } }), /expects a value/);
});

await test("a non-numeric value for a number option is an error", () => {
  assert.throws(() => parseArgs(["--port", "abc"], { port: { type: "number" } }), /expects a number/);
});

await test("-- stops parsing so a task can contain dashes", () => {
  const { positional } = parseArgs(["--", "--not-a-flag", "text"], { real: { type: "string" } });
  assert.deepStrictEqual(positional, ["--not-a-flag", "text"]);
});

await test("negative numbers are values, not flags", () => {
  const { flags } = parseArgs(["--port", "-1"], { port: { type: "number" } });
  assert.strictEqual(flags.port, -1);
});

// ── Secret handling ──────────────────────────────────────────────────────────

section("config — secrets never print");

await test("secret-looking keys are recognised regardless of case or nesting", () => {
  for (const key of ["apiKey", "API_KEY", "textApiKey", "token", "clientSecret", "password", "AUTHORIZATION"]) {
    assert.ok(isSecretKey(key), `${key} should be treated as a secret`);
  }
  assert.ok(!isSecretKey("model"));
  assert.ok(!isSecretKey("port"));
});

await test("maskSecret keeps a value identifiable but unusable", () => {
  const masked = maskSecret("sk-proj-abcdefghijklmnop");
  assert.ok(!masked.includes("abcdefghijklmno"), "the body of the key must not survive");
  assert.ok(masked.startsWith("sk-"));
  assert.strictEqual(maskSecret(""), "(not set)");
});

await test("redact walks nested objects and arrays", () => {
  const out = redact({
    model: "gpt-5",
    apiKey: "sk-secret-value-here",
    mcpServers: { github: { env: { GITHUB_TOKEN: "ghp_secretsecret" } } },
    list: [{ password: "hunter2" }],
  });
  assert.strictEqual(out.model, "gpt-5");
  assert.ok(!JSON.stringify(out).includes("sk-secret-value-here"));
  assert.ok(!JSON.stringify(out).includes("ghp_secretsecret"));
  assert.ok(!JSON.stringify(out).includes("hunter2"));
});

await test("flatten masks secrets on the way to `config list`", () => {
  const rows = flatten({ apiKey: "sk-abcdefghijklmnop", model: "gpt-5" });
  const apiRow = rows.find(([k]) => k === "apiKey");
  assert.ok(!String(apiRow[1]).includes("abcdefghijkl"));
});

await test("coerceValue turns CLI strings into real types", () => {
  assert.strictEqual(coerceValue("true"), true);
  assert.strictEqual(coerceValue("false"), false);
  assert.strictEqual(coerceValue("4173"), 4173);
  assert.strictEqual(coerceValue("gpt-4.1-nano"), "gpt-4.1-nano");
  // A model name that looks numeric must not become a number.
  assert.strictEqual(typeof coerceValue("o3"), "string");
});

section("config — precedence");

await test("saved config outranks a stray environment variable", withTempHome(async (home) => {
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ model: "from-config" }));
  const previous = process.env.DEFAULT_MODEL;
  process.env.DEFAULT_MODEL = "from-environment";
  try {
    const { config, sources } = resolveConfig({});
    assert.strictEqual(config.model, "from-config",
      "a shell variable left over from another tool must not silently outrank the model the user saved");
    assert.strictEqual(sources.model, "user");
  } finally {
    if (previous === undefined) delete process.env.DEFAULT_MODEL;
    else process.env.DEFAULT_MODEL = previous;
  }
}));

await test("CLI arguments outrank everything", withTempHome(async (home) => {
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ model: "from-config" }));
  const { config } = resolveConfig({ cliFlags: { model: "from-argument" } });
  assert.strictEqual(config.model, "from-argument");
}));

await test("project config outranks user config", withTempHome(async (home) => {
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ permission: "auto" }));
  const ws = tempWorkspace({ ".kodo/settings.json": JSON.stringify({ kodo: { permission: "plan" } }) });
  try {
    const { config } = resolveConfig({ workspace: ws });
    assert.strictEqual(config.permission, "plan");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}));

// ── The binary ───────────────────────────────────────────────────────────────

section("kodo — the executable");

await test("--version prints just the version on stdout", async () => {
  const r = await runCli(["--version"]);
  assert.strictEqual(r.code, EXIT.OK);
  // Full semver, including prereleases: Kodo's first public publish is
  // `2.0.0-rc.1`, and a regex that rejects prereleases would fail every
  // release candidate for no reason.
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/);
});

await test("--help lists every command", async () => {
  const r = await runCli(["--help"]);
  assert.strictEqual(r.code, EXIT.OK);
  for (const cmd of ["chat", "run", "init", "config", "ui", "doctor", "status", "sessions"]) {
    assert.ok(r.stdout.includes(cmd), `help should mention ${cmd}`);
  }
});

await test("piped output contains no ANSI escape codes", async () => {
  const r = await runCli(["help"], { env: { NO_COLOR: "" } });
  // eslint-disable-next-line no-control-regex
  assert.ok(!/\[/.test(r.stdout), "escape codes must not reach a pipe");
});

await test("an unknown command exits 2 with a pointer to help", async () => {
  const r = await runCli(["definitely-not-a-command"]);
  assert.strictEqual(r.code, EXIT.USAGE);
  assert.ok(r.stderr.includes("Unknown command"));
  assert.ok(r.stderr.includes("kodo help"));
  assert.strictEqual(r.stdout.trim(), "", "errors belong on stderr, not stdout");
});

await test("an unknown option exits 2", async () => {
  const r = await runCli(["status", "--not-a-real-flag"]);
  assert.strictEqual(r.code, EXIT.USAGE);
});

await test("`run` with no task and no stdin exits 2 rather than hanging", async () => {
  const r = await runCli(["run"], { timeoutMs: 20_000 });
  assert.ok(!r.timedOut, "must not block waiting for input that will never come");
  assert.strictEqual(r.code, EXIT.USAGE);
});

await test("status works on a machine with nothing configured", withTempHome(async (home) => {
  const r = await runCli(["status"], { home, env: { OPENAI_API_KEY: "", DEFAULT_MODEL: "" } });
  assert.strictEqual(r.code, EXIT.OK);
  assert.ok(r.stderr.includes("Kodo"));
}));

await test("status --json emits parseable JSON with no credential in it", withTempHome(async (home) => {
  fs.writeFileSync(path.join(home, "config.json"),
    JSON.stringify({ model: "test-model", apiKey: "sk-this-must-never-appear" }));
  const r = await runCli(["status", "--json"], { home });
  assert.strictEqual(r.code, EXIT.OK);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.model, "test-model");
  assert.ok(!r.stdout.includes("sk-this-must-never-appear"),
    "status --json must never carry the API key, even for a machine consumer");
}));

await test("config set then get round-trips, with the secret masked on the way out",
  withTempHome(async (home) => {
    let r = await runCli(["config", "set", "apiKey", "sk-round-trip-secret-1234"], { home });
    assert.strictEqual(r.code, EXIT.OK);
    assert.ok(!r.stderr.includes("sk-round-trip-secret-1234"), "confirmation must not echo the secret");

    r = await runCli(["config", "get", "apiKey"], { home });
    assert.strictEqual(r.code, EXIT.OK);
    assert.ok(!r.stdout.includes("round-trip-secret"), "`config get` must not print the real key");

    // …but it really was saved.
    const saved = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf-8"));
    assert.strictEqual(saved.apiKey, "sk-round-trip-secret-1234");
  }));

await test("the user config file is written 0600", withTempHome(async (home) => {
  await runCli(["config", "set", "apiKey", "sk-permissions-check"], { home });
  const mode = fs.statSync(path.join(home, "config.json")).mode & 0o777;
  assert.strictEqual(mode, 0o600, `config holding credentials must not be world-readable (got ${mode.toString(8)})`);
}));

await test("a corrupt config file produces a config error, not a crash", withTempHome(async (home) => {
  fs.writeFileSync(path.join(home, "config.json"), "{ this is not json");
  const r = await runCli(["config", "list"], { home });
  assert.strictEqual(r.code, EXIT.CONFIG);
  assert.ok(r.stderr.includes("not valid JSON"));
}));

await test("run without a model configured exits 3 (config), not 1 (task failed)",
  withTempHome(async (home) => {
    const ws = tempWorkspace({ "a.txt": "hello" });
    try {
      const r = await runCli(["run", "do something", "--cwd", ws], {
        home,
        env: { DEFAULT_MODEL: "", OPENAI_API_KEY: "", KODO_CORE_PATH: "" },
        timeoutMs: 30_000,
      });
      assert.strictEqual(r.code, EXIT.CONFIG,
        "a missing model is a configuration problem and must be distinguishable from a failed task");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }));

await test("run with a model but no key exits 4 (auth)", withTempHome(async (home) => {
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ model: "some-model" }));
  const ws = tempWorkspace({ "a.txt": "hello" });
  try {
    const r = await runCli(["run", "do something", "--cwd", ws], {
      home, env: { OPENAI_API_KEY: "", DEFAULT_MODEL: "" }, timeoutMs: 30_000,
    });
    assert.strictEqual(r.code, EXIT.AUTH);
    assert.ok(/api key/i.test(r.stderr));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}));

await test("run against a directory that does not exist exits 2", withTempHome(async (home) => {
  const r = await runCli(["run", "x", "--cwd", "/no/such/directory/anywhere"], { home, timeoutMs: 20_000 });
  assert.strictEqual(r.code, EXIT.USAGE);
}));

await test("completion scripts are generated for every supported shell", async () => {
  for (const shell of ["bash", "zsh", "fish"]) {
    const r = await runCli(["completion", shell]);
    assert.strictEqual(r.code, EXIT.OK, `${shell} completion should succeed`);
    assert.ok(r.stdout.includes("kodo"), `${shell} completion should reference kodo`);
  }
  const bad = await runCli(["completion", "powershell"]);
  assert.strictEqual(bad.code, EXIT.USAGE);
});

await test("sessions lists nothing gracefully on a fresh install", withTempHome(async (home) => {
  const r = await runCli(["sessions"], { home });
  assert.strictEqual(r.code, EXIT.OK);
  assert.ok(/no sessions/i.test(r.stderr));
}));

await test("a provider failure exits 4 and is NOT reported as a completed task",
  withTempHome(async (home) => {
    // A model endpoint that always rejects. The agent will run, get refused,
    // and explain it in prose — which is a non-empty answer, and used to be
    // reported as success with exit 0. A CI job cannot tell that apart from
    // work actually getting done.
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
      model: "test-model",
      apiKey: "sk-definitely-invalid",
      // Loopback with nothing listening: fails fast, no external call.
      baseUrl: "http://127.0.0.1:1/v1",
    }));
    const ws = tempWorkspace({ "a.txt": "hello" });
    try {
      const r = await runCli(["run", "do something", "--cwd", ws, "--json"], { home, timeoutMs: 120_000 });
      assert.notStrictEqual(r.code, EXIT.OK,
        "a run whose provider never answered must not exit 0");

      const lines = r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const completed = lines.find((e) => e.type === "session_completed");
      assert.ok(completed, "the stream should still end with session_completed");
      assert.strictEqual(completed.success, false,
        "a provider failure is not a successful session, however polite the prose");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }));

await test("`kodo init` succeeds on a machine with no model configured",
  withTempHome(async (home) => {
    // `init` is the first command a new user runs after `npm install -g`, and
    // on a fresh machine there is no provider yet. It used to exit 3 — AFTER
    // writing .kodo/ — because generating KODO.md needs a model and that error
    // aborted the whole command. The user was left with a half-made project and
    // an error, and nothing said the scaffolding had in fact worked.
    //
    // Only KODO.md is model-backed. Everything the rest of Kodo reads —
    // settings, commands, skills, agents — is not.
    //
    // The provider variables are scrubbed explicitly: runCli inherits the real
    // environment, and a developer machine (or this repository's own .env) has
    // a key in it, so without this the test would quietly exercise the
    // model-configured path and prove nothing.
    const ws = tempWorkspace({ "a.txt": "hello" });
    const noProvider = {
      OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", KODO_API_KEY: "",
      DEFAULT_MODEL: "", KODO_MODEL: "", OPENAI_BASE_URL: "", KODO_BASE_URL: "",
    };
    try {
      const r = await runCli(["init", "--cwd", ws], { home, env: noProvider, timeoutMs: 120_000 });

      assert.strictEqual(r.code, EXIT.OK,
        `init must succeed without a provider, got ${r.code}: ${r.stderr.slice(0, 200)}`);
      // Human-readable output goes to stderr; stdout is reserved for
      // machine-readable output (see routeConsoleToStderr).
      assert.match(r.stderr, /no model is configured/i,
        "it should say WHY KODO.md was skipped, not fail silently");

      // The project must be genuinely usable, not partially written.
      for (const rel of ["settings.json", "commands", "skills", "agents"]) {
        assert.ok(fs.existsSync(path.join(ws, ".kodo", rel)), `.kodo/${rel} should exist`);
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }));

finish();
