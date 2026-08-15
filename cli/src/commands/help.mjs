/**
 * src/commands/help.mjs — the command surface, described in one place.
 *
 * This table is the single source for `kodo help`, `kodo <cmd> --help` and
 * shell completion, so a command cannot be added without becoming discoverable.
 */

import { out } from "../term.mjs";
import { style } from "../term.mjs";

export const COMMANDS = {
  chat: {
    summary: "Start an interactive coding session",
    usage: "kodo chat [--cwd DIR] [--model NAME] [--permission MODE] [--resume ID]",
    details: [
      "The default when you run bare `kodo` in a terminal.",
      "",
      "  --cwd DIR           Project to work in (default: current directory)",
      "  --model NAME        Override the configured model for this session",
      "  --permission MODE   auto | ask | plan  (default: auto)",
      "  --resume ID         Continue a previous session (see `kodo sessions`)",
      "  --sandbox KIND      host (default) | docker",
      "",
      "A sandbox confines BOTH file operations and process execution. If the",
      "requested one cannot prove isolation on this machine, Kodo refuses to",
      "run rather than falling back to the host.",
      "",
      "An Incus runtime exists but is NOT verified against a live daemon, so it",
      "is not offered here. See docs/incus.md.",
    ],
  },
  run: {
    summary: "Run one task non-interactively",
    usage: 'kodo run "fix the failing tests" [--json] [--cwd DIR]',
    details: [
      "Built for scripts and CI. Exits 0 on success, 1 if the task failed.",
      "",
      "  --json              Emit JSON Lines events on stdout, nothing else",
      "  --cwd DIR           Project to work in",
      "  --model NAME        Override the configured model",
      "  --permission MODE   auto | ask | plan (default: auto)",
      "  --quiet             Suppress tool-activity output on stderr",
      "  --sandbox KIND      host (default) | docker — see `kodo chat --help`",
      "",
      "Reads the task from stdin when no argument is given, so this works:",
      "  echo 'fix the lint errors' | kodo run",
    ],
  },
  init: {
    summary: "Set up Kodo in this project",
    usage: "kodo init [--cwd DIR] [--force]",
    details: [
      "Creates .kodo/ and generates KODO.md by inspecting the repository.",
      "KODO.md is validated against real files before it is written — an",
      "existing one is never overwritten with an unverifiable draft.",
      "",
      "  --force             Regenerate KODO.md even if one already exists",
      "  --no-instructions   Create .kodo/ only; skip KODO.md generation",
    ],
  },
  config: {
    summary: "Read and write configuration",
    usage: "kodo config <get|set|list|path> [key] [value]",
    details: [
      "  kodo config list              Show effective config (secrets masked)",
      "  kodo config get model         Read one key",
      "  kodo config set model gpt-5   Write one key to ~/.kodo/config.json",
      "  kodo config path              Where the config file lives",
      "",
      "Secrets are never printed in full, by any subcommand.",
    ],
  },
  ui: {
    summary: "Manage the local web UI server",
    usage: "kodo ui <start|stop|restart|status> [--port N] [--host H] [--detach] [--open]",
    details: [
      "  --port N        Port to bind; 0 picks a free one (default: 4173)",
      "  --host H        Interface to bind (default: 127.0.0.1)",
      "  --detach        Run in the background and return immediately",
      "  --open          Open the URL in your browser",
      "",
      "Binding to anything other than a loopback address exposes an agent that",
      "can edit files and run commands, so it requires --yes-i-know.",
    ],
  },
  server: {
    summary: "Manage the Kodo runtime server (used by the extension and web app)",
    usage: "kodo server <start|stop|restart|status>",
    details: [
      "Same lifecycle as `kodo ui`, tracked separately, for the backend1",
      "Fastify server that the VS Code extension and the Next.js UI talk to.",
    ],
  },
  sessions: {
    summary: "List past sessions",
    usage: "kodo sessions [--json]",
  },
  resume: {
    summary: "Continue a previous session",
    usage: "kodo resume <id>",
  },
  status: {
    summary: "Show what Kodo is doing right now",
    usage: "kodo status [--json]",
  },
  doctor: {
    summary: "Check that this installation works",
    usage: "kodo doctor [--json]",
  },
  update: {
    summary: "Update this Kodo installation",
    usage: "kodo update [--check]",
    details: [
      "  --check             Report whether an update is available, without applying it",
      "",
      "Kodo has no published binary releases yet, so updates come from the source",
      "checkout install.sh installed from. Your configuration in ~/.kodo is never",
      "touched, and an update refuses to run over uncommitted local changes.",
    ],
  },
  uninstall: {
    summary: "Remove Kodo from this machine",
    usage: "kodo uninstall [--cache] [--config] [--all] [--yes]",
    details: [
      "By default removes only the `kodo` launcher from your PATH.",
      "",
      "  --cache             Also remove logs, runtime state and saved sessions",
      "  --config            Also remove ~/.kodo/config.json (INCLUDING your API key)",
      "  --all               Both of the above",
      "  --yes               Skip the confirmation prompt",
      "",
      "Never removes your projects, their .kodo/ directories, or KODO.md.",
      "The source checkout is left in place for you to delete.",
    ],
  },
  completion: {
    summary: "Print a shell completion script",
    usage: "kodo completion <bash|zsh|fish>",
  },
  version: {
    summary: "Print the version",
    usage: "kodo version",
  },
  help: {
    summary: "Show this help",
    usage: "kodo help [command]",
  },
};

export function helpFor(name) {
  const cmd = COMMANDS[name];
  if (!cmd) return null;
  return [
    `${style.bold(`kodo ${name}`)} — ${cmd.summary}`,
    "",
    `  ${cmd.usage}`,
    ...(cmd.details?.length ? ["", ...cmd.details.map((l) => (l ? `  ${l}` : ""))] : []),
    "",
  ].join("\n");
}

export function generalHelp(version) {
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  return [
    `${style.bold("kodo")} — AI coding agent ${style.dim(`v${version}`)}`,
    "",
    `${style.bold("USAGE")}`,
    "  kodo                      Start an interactive session here",
    '  kodo run "<task>"         Run one task and exit',
    "  kodo <command> [options]",
    "",
    `${style.bold("COMMANDS")}`,
    ...Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(width + 2)}${c.summary}`),
    "",
    `${style.bold("GLOBAL OPTIONS")}`,
    "  -h, --help                Show help",
    "  -v, --version             Show version",
    "      --verbose             More detail on stderr",
    "      --debug               Internal diagnostics on stderr",
    "      --no-color            Disable colour",
    "",
    `Run ${style.cyan("kodo help <command>")} for details on one command.`,
    "",
  ].join("\n");
}

export function helpCommand({ positional, version }) {
  const topic = positional[0];
  if (topic) {
    const text = helpFor(topic);
    if (!text) {
      out(generalHelp(version));
      return 2;
    }
    out(text);
    return 0;
  }
  out(generalHelp(version));
  return 0;
}
