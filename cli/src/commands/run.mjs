/**
 * src/commands/run.mjs — `kodo run "<task>"`.
 *
 * The automation surface: one task, no prompts, a meaningful exit code, and in
 * --json mode a stdout stream that is nothing but JSON Lines. This is what CI
 * and other agents call.
 */

import { parseArgs } from "../args.mjs";
import { EXIT, usageError, CliError } from "../exit.mjs";
import { resolveConfig } from "../config.mjs";
import { buildModelRoute } from "../creds.mjs";
import { detectWorkspace } from "../workspace.mjs";
import { loadCore } from "../core.mjs";
import { humanRenderer, jsonRenderer } from "../events.mjs";
import { runTurn } from "../agent.mjs";
import { openSandbox } from "../sandbox.mjs";
import * as sessions from "../sessions.mjs";
import { log, style, ok } from "../term.mjs";

const SPEC = {
  cwd:        { type: "string" },
  model:      { type: "string" },
  permission: { type: "string" },
  session:    { type: "string" },
  json:       { type: "boolean" },
  quiet:      { type: "boolean" },
  "no-ui":    { type: "boolean" },
  sandbox:    { type: "string" },
  verbose:    { type: "boolean" },
  debug:      { type: "boolean" },
  color:      { type: "boolean", default: true },
  help:       { type: "boolean", short: "h" },
};

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8").trim();
}

export async function runCommand({ argv }) {
  const { flags, positional } = parseArgs(argv, SPEC);

  // No argument? Read the task from stdin, so `… | kodo run` composes.
  const task = positional.join(" ").trim() || (await readStdin());
  if (!task) {
    throw usageError(
      "No task given.",
      'Usage: kodo run "fix the failing tests"   (or pipe the task on stdin)',
    );
  }

  const workspace = detectWorkspace(flags.cwd);
  if (!workspace.exists) {
    throw usageError(`Directory does not exist: ${workspace.path}`);
  }

  const { config } = resolveConfig({
    workspace: workspace.path,
    cliFlags: { model: flags.model, permission: flags.permission },
  });

  const permissionMode = config.permission || "auto";
  const core = await loadCore();
  if (!core.isPermissionMode(permissionMode)) {
    throw usageError(
      `Unknown permission mode "${permissionMode}".`,
      `Valid modes: ${core.PERMISSION_MODES.join(", ")}`,
    );
  }

  const modelRoute = buildModelRoute(config);
  const renderer = flags.json ? jsonRenderer() : humanRenderer({ quiet: flags.quiet });

  // Opened BEFORE any work starts. If a sandbox was asked for and cannot be
  // proven, this throws and nothing runs — the agent never touches the
  // workspace under a guarantee that was not met.
  const sandbox = await openSandbox({
    core,
    sandbox: flags.sandbox,
    workspace: workspace.path,
    quiet: flags.quiet,
    json: flags.json,
  });

  sessions.ensureStore();
  const session = flags.session
    ? sessions.load(flags.session) || sessions.createSession({ id: flags.session, workspace: workspace.path })
    : sessions.createSession({ workspace: workspace.path, title: task });

  // Ctrl+C cancels the RUN, not the process — the agent gets its abort signal
  // so it can stop child processes and MCP servers instead of orphaning them.
  const controller = new AbortController();
  let interrupted = false;
  const onSigint = () => {
    if (interrupted) process.exit(EXIT.TASK_FAILURE);   // second Ctrl+C is impatient; obey it
    interrupted = true;
    if (!flags.json) log(style.yellow("\n  interrupt — stopping the agent (Ctrl+C again to force)"));
    controller.abort();
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigint);

  try {
    const result = await runTurn({
      core,
      session,
      message: task,
      workspace: workspace.path,
      modelRoute,
      permissionMode,
      renderer,
      // Non-interactive: a clarifying question has nobody to answer it. Telling
      // the agent so lets it proceed on its own judgment and say what it
      // assumed, which is far better than blocking a CI job for ten minutes.
      askUser: async ({ question }) => {
        if (!flags.json) log(style.yellow(`  ? ${question} (non-interactive — proceeding)`));
        return "(running non-interactively, no user is available to answer — proceed using your best judgment and state the assumption you made)";
      },
      signal: controller.signal,
      runtime: sandbox.runtime,
    });

    renderer.finish();

    if (result.cancelled) return EXIT.TASK_FAILURE;

    // A provider that rejected us is not a task that failed. Reporting exit 0
    // here — which happened when the model returned a 403 quota error and the
    // agent politely explained it in prose — tells a CI job the work was done.
    if (result.providerError) {
      const message = String(result.providerError.message || "");
      const isAuth = /\b(401|403|429)\b|quota|unauthor|invalid api key|incorrect api key|rate limit/i.test(message);
      if (!flags.json) {
        log(`${style.red("error")} the model provider failed: ${message.slice(0, 200)}`);
        if (isAuth) log(style.dim("  Check your API key, quota and billing, then run `kodo doctor`."));
      }
      return isAuth ? EXIT.AUTH : EXIT.TASK_FAILURE;
    }

    if (!flags.json && !flags.quiet && result.editedFiles.length) {
      ok(`${result.editedFiles.length} file(s) changed`);
    }
    if (!flags.json && !flags.quiet) {
      log(style.dim(`  session ${sessions.shortId(session.id)} — resume with \`kodo resume ${sessions.shortId(session.id)}\``));
    }

    return result.finalAnswer ? EXIT.OK : EXIT.TASK_FAILURE;
  } catch (err) {
    if (err instanceof CliError) throw err;
    if (/401|403|unauthor|invalid api key|incorrect api key/i.test(err.message)) {
      throw new CliError(`The model provider rejected the request: ${err.message}`, EXIT.AUTH);
    }
    if (/permission|not allowed|denied/i.test(err.message)) {
      throw new CliError(err.message, EXIT.PERMISSION);
    }
    throw new CliError(err.message, EXIT.TASK_FAILURE);
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigint);
    // Unconditional: a failed task, a thrown error and a Ctrl+C must all tear
    // the container down. A leaked one holds a copy of the user's source.
    await sandbox.dispose();
  }
}
