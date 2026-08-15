/**
 * src/commands/chat.mjs — `kodo chat`, and what bare `kodo` runs.
 *
 * An interactive session over the same agent `kodo run` uses. Conversation
 * state lives in the session file and is replayed into the agent's working
 * memory each turn via core's own conversationStore, so turn 5 knows what turn
 * 2 actually did — the tool calls and their results, not a summary of them.
 */

import readline from "readline";

import { parseArgs } from "../args.mjs";
import { EXIT, usageError, CliError } from "../exit.mjs";
import { resolveConfig } from "../config.mjs";
import { buildModelRoute } from "../creds.mjs";
import { detectWorkspace, describeWorkspace } from "../workspace.mjs";
import { loadCore } from "../core.mjs";
import { humanRenderer } from "../events.mjs";
import { runTurn } from "../agent.mjs";
import { openSandbox } from "../sandbox.mjs";
import * as sessions from "../sessions.mjs";
import { banner, log, style, warn } from "../term.mjs";

const SPEC = {
  cwd:        { type: "string" },
  model:      { type: "string" },
  permission: { type: "string" },
  resume:     { type: "string" },
  sandbox:    { type: "string" },
  help:       { type: "boolean", short: "h" },
  verbose:    { type: "boolean" },
  debug:      { type: "boolean" },
  color:      { type: "boolean", default: true },
};

const LOCAL_COMMANDS = new Set(["/exit", "/quit", "/clear", "/session", "/cwd"]);

export async function chatCommand({ argv, resumeId = "" }) {
  const { flags, positional } = parseArgs(argv, SPEC);

  const workspace = detectWorkspace(flags.cwd);
  if (!workspace.exists) throw usageError(`Directory does not exist: ${workspace.path}`);

  const { config } = resolveConfig({
    workspace: workspace.path,
    cliFlags: { model: flags.model, permission: flags.permission },
  });

  const core = await loadCore();
  const permissionMode = config.permission || "auto";
  if (!core.isPermissionMode(permissionMode)) {
    throw usageError(`Unknown permission mode "${permissionMode}".`, `Valid modes: ${core.PERMISSION_MODES.join(", ")}`);
  }

  const modelRoute = buildModelRoute(config);

  // One sandbox for the whole session, not one per turn: a container per
  // message would throw away everything the previous turn installed or built,
  // and the agent would relearn the same environment on every message.
  const sandbox = await openSandbox({ core, sandbox: flags.sandbox, workspace: workspace.path });

  sessions.ensureStore();
  const wanted = resumeId || flags.resume || positional[0];
  let session = wanted ? sessions.load(wanted) : null;
  if (wanted && !session) {
    throw usageError(`No session "${wanted}".`, "Run `kodo sessions` to see what is available.");
  }
  if (!session) session = sessions.createSession({ workspace: workspace.path });

  // Banner and status go to stderr — `kodo chat > transcript.md` should capture
  // the conversation, not the chrome around it.
  log(banner(core.VERSION));
  log("");
  for (const line of describeWorkspace(workspace)) log(style.dim(`  ${line}`));
  log(style.dim(`  Model: ${modelRoute.model}`));
  log(style.dim(`  Permission: ${permissionMode}`));
  log(style.dim(`  Runtime: ${sandbox.runtime ? `${sandbox.runtime.name} (isolated)` : "host"}`));
  if (session.events.length) {
    log(style.dim(`  Resumed session ${sessions.shortId(session.id)} — ${session.turns} previous turn(s)`));
  }
  if (workspace.git && !workspace.git.clean) {
    warn(`${workspace.git.dirtyFiles} uncommitted change(s) — Kodo edits files in place. Commit first if you want a clean undo point.`);
  }
  log("");
  log(style.dim("  /exit to quit · /clear to start a fresh session · Ctrl+C to interrupt a running task"));
  log("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: `${style.cyan("›")} `,
    historySize: 200,
  });

  let running = null;   // AbortController while the agent is working

  // While a task runs, Ctrl+C stops THAT task. At the prompt it exits.
  rl.on("SIGINT", () => {
    if (running) {
      log(style.yellow("\n  interrupt — stopping the current task"));
      running.abort();
      return;
    }
    rl.close();
  });

  let exitCode = EXIT.OK;

  const ask = () => new Promise((resolve) => {
    rl.prompt();
    rl.once("line", (line) => resolve(line));
    rl.once("close", () => resolve(null));
  });

  for (;;) {
    const line = await ask();
    if (line === null) break;
    const input = line.trim();
    if (!input) continue;

    if (LOCAL_COMMANDS.has(input.split(/\s+/)[0])) {
      const [cmd] = input.split(/\s+/);
      if (cmd === "/exit" || cmd === "/quit") break;
      if (cmd === "/clear") {
        session = sessions.createSession({ workspace: workspace.path });
        log(style.dim(`  new session ${sessions.shortId(session.id)}`));
        continue;
      }
      if (cmd === "/session") {
        log(style.dim(`  ${session.id} · ${session.turns} turn(s) · ${session.events.length} recorded event(s)`));
        continue;
      }
      if (cmd === "/cwd") { log(style.dim(`  ${workspace.path}`)); continue; }
    }

    running = new AbortController();
    try {
      const result = await runTurn({
        core,
        session,
        message: input,
        workspace: workspace.path,
        modelRoute,
        permissionMode,
        renderer: humanRenderer(),
        // Interactive: the agent's ask_user tool gets a real prompt on the
        // terminal instead of the "nobody is here" answer `kodo run` supplies.
        askUser: ({ question, options }) => askUserInteractively(rl, question, options),
        signal: running.signal,
        runtime: sandbox.runtime,
      });
      process.stdout.write("\n");
      if (result.editedFiles.length) {
        log(style.green(`  ✓ ${result.editedFiles.length} file(s) changed`));
      }
      log("");
    } catch (err) {
      exitCode = err instanceof CliError ? err.code : EXIT.TASK_FAILURE;
      log(`${style.red("error")} ${err.message}`);
      log("");
      // A failed turn does not end the session — the user may want to retry or
      // ask something else, and their conversation history is still valid.
    } finally {
      running = null;
    }
  }

  rl.close();
  await sandbox.dispose();
  log(style.dim(`\n  session ${sessions.shortId(session.id)} saved — resume with \`kodo resume ${sessions.shortId(session.id)}\``));
  return exitCode;
}

/** Surface the agent's ask_user question on the terminal and wait for a reply. */
function askUserInteractively(rl, question, options = []) {
  return new Promise((resolve) => {
    log("");
    log(`${style.yellow("?")} ${style.bold(question)}`);
    for (const [i, opt] of options.entries()) {
      log(style.dim(`    ${i + 1}. ${typeof opt === "string" ? opt : opt.label || ""}`));
    }
    rl.question(`${style.yellow("›")} `, (answer) => {
      const trimmed = String(answer).trim();
      // Let the user answer "2" when options were offered.
      const asIndex = Number(trimmed);
      if (options.length && Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= options.length) {
        const chosen = options[asIndex - 1];
        return resolve(typeof chosen === "string" ? chosen : chosen.label || trimmed);
      }
      resolve(trimmed || "(the user pressed enter without answering — use your best judgment)");
    });
  });
}
