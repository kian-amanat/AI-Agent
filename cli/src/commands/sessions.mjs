/**
 * src/commands/sessions.mjs — `kodo sessions`.
 */

import { parseArgs } from "../args.mjs";
import { EXIT, usageError } from "../exit.mjs";
import * as sessions from "../sessions.mjs";
import { displayPath } from "../workspace.mjs";
import { out, log, style } from "../term.mjs";

const SPEC = {
  json:    { type: "boolean" },
  all:     { type: "boolean" },
  help:    { type: "boolean", short: "h" },
  color:   { type: "boolean", default: true },
  verbose: { type: "boolean" },
  debug:   { type: "boolean" },
};

export async function sessionsCommand({ argv }) {
  const { flags, positional } = parseArgs(argv, SPEC);
  const action = positional[0] || "list";

  if (action === "rm" || action === "delete") {
    const id = positional[1];
    if (!id) throw usageError("Usage: kodo sessions rm <id>");
    if (!sessions.remove(id)) throw usageError(`No session "${id}".`);
    log(style.green(`✓ removed session ${id}`));
    return EXIT.OK;
  }

  const all = sessions.list();

  if (flags.json) {
    out(JSON.stringify({
      ok: true,
      sessions: all.map((s) => ({
        id: s.id, short: sessions.shortId(s.id), workspace: s.workspace,
        title: s.title, status: s.status, turns: s.turns, updatedAt: s.updatedAt,
      })),
    }, null, 2));
    return EXIT.OK;
  }

  if (!all.length) {
    log(style.dim("No sessions yet. Run `kodo chat` to start one."));
    return EXIT.OK;
  }

  const rows = all.slice(0, flags.all ? all.length : 20);
  const wsWidth = Math.min(28, Math.max(9, ...rows.map((s) => displayPath(s.workspace || "").length)));

  log("");
  log(`  ${style.dim("ID".padEnd(8))}${style.dim("WORKSPACE".padEnd(wsWidth + 2))}${style.dim("TURNS".padEnd(7))}${style.dim("TITLE")}`);
  for (const s of rows) {
    const ws = displayPath(s.workspace || "").slice(-wsWidth);
    log(`  ${sessions.shortId(s.id).padEnd(8)}${ws.padEnd(wsWidth + 2)}${String(s.turns).padEnd(7)}${style.dim((s.title || "").slice(0, 46))}`);
  }
  log("");
  if (all.length > rows.length) log(style.dim(`  … ${all.length - rows.length} more (--all to show)`));
  log(style.dim("  Continue one with `kodo resume <id>`."));
  log("");
  return EXIT.OK;
}
