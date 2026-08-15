#!/usr/bin/env node
/**
 * scripts/validate-docs.mjs — prove the documentation matches the CLI.
 *
 * Documentation drifts silently. A flag gets renamed, a command gets dropped,
 * and the docs keep confidently telling people to run something that no longer
 * works — which is worse than no docs, because the reader trusts it.
 *
 * So this does not read the docs for plausibility. It extracts every `kodo …`
 * invocation and every `--flag` from docs/ and README.md, then checks each one
 * against the ACTUAL command tree and argument parsers in the source.
 *
 * Checks:
 *   1. every documented command exists
 *   2. every documented flag is accepted by that command's parser
 *   3. every implemented command is documented somewhere
 *   4. no fabricated URLs (anything claiming to be a Kodo release host)
 *
 * Usage: node scripts/validate-docs.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const CLI = path.join(REPO, "cli");

let failures = 0;
let checked = 0;
const problem = (msg) => { console.error(`  ❌ ${msg}`); failures++; };
const ok = (msg) => console.log(`  ✅ ${msg}`);

// ── The implementation, read from source ─────────────────────────────────────

/** Commands the dispatcher actually handles. */
function implementedCommands() {
  const src = fs.readFileSync(path.join(CLI, "src", "main.mjs"), "utf-8");
  const body = src.slice(src.indexOf("switch (command)"));
  const cases = [...body.matchAll(/case\s+"([\w-]+)"\s*:/g)].map((m) => m[1]);
  const aliases = [...src.matchAll(/^\s*(\w+):\s*"(\w+)",$/gm)].map((m) => m[1]);
  return new Set([...cases, ...aliases]);
}

/** Flags each command's parser accepts, from its SPEC object. */
function implementedFlags() {
  const byCommand = {};
  const dir = path.join(CLI, "src", "commands");
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".mjs")) continue;
    const src = fs.readFileSync(path.join(dir, file), "utf-8");
    const i = src.indexOf("const SPEC");
    if (i === -1) continue;
    const spec = src.slice(i, src.indexOf("};", i));
    const flags = [...spec.matchAll(/^\s*"?([\w-]+)"?:\s*\{/gm)].map((m) => m[1]);
    byCommand[path.basename(file, ".mjs")] = new Set(flags);
  }
  return byCommand;
}

/** Which command file backs which command name. */
const COMMAND_FILE = {
  chat: "chat", run: "run", init: "init", config: "config",
  ui: "ui", server: "ui", status: "status", doctor: "doctor",
  sessions: "sessions", resume: "chat", update: "update",
  uninstall: "uninstall", completion: "completion",
  help: "help", version: null, "": "chat",
};

/** Subcommands each command accepts, read from source rather than assumed. */
function implementedSubcommands() {
  const read = (f) => fs.readFileSync(path.join(CLI, "src", "commands", f), "utf-8");
  const grab = (src, re) => new Set([...src.matchAll(re)].map((m) => m[1]));
  return {
    ui: grab(read("ui.mjs"), /case\s+"(\w+)":\s*return \w+Action/g),
    server: grab(read("ui.mjs"), /case\s+"(\w+)":\s*return \w+Action/g),
    config: grab(read("config.mjs"), /action === "(\w+)"/g),
    sessions: new Set(["list", "rm", "delete"]),
    completion: new Set(["bash", "zsh", "fish"]),
  };
}

// ── The documentation ────────────────────────────────────────────────────────

function docFiles() {
  const files = [path.join(REPO, "README.md")];
  const dir = path.join(REPO, "docs");
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".md")) files.push(path.join(dir, f));
  return files;
}

/**
 * Every `kodo …` invocation, taken ONLY from fenced code blocks and inline
 * code spans.
 *
 * Scanning raw prose produced nonsense candidates — "kodo Interactive" from a
 * sentence, "kodo server The" from a table cell — which is worse than useless:
 * a validator that cries wolf gets ignored, and then real drift ships. Code
 * blocks and backticks are where commands the reader will actually COPY live,
 * and those are the ones that must be true.
 */
function documentedInvocations() {
  const found = [];

  for (const file of docFiles()) {
    const rel = path.relative(REPO, file);
    const lines = fs.readFileSync(file, "utf-8").split("\n");
    let inFence = false;

    lines.forEach((line, i) => {
      if (/^\s*```/.test(line)) { inFence = !inFence; return; }

      const candidates = [];
      if (inFence) {
        // A whole line inside a fence, minus a shell prompt.
        const cleaned = line.replace(/^\s*[$>]\s*/, "").trim();
        if (cleaned.startsWith("kodo ") || cleaned === "kodo") candidates.push(cleaned);
      } else {
        // Inline `kodo …` spans only.
        for (const m of line.matchAll(/`(kodo(?:\s[^`]*)?)`/g)) candidates.push(m[1].trim());
      }

      for (const raw of candidates) {
        // Split on the alignment gap FIRST. A summary block lines descriptions
        // up with runs of spaces:
        //   kodo                    Interactive session in the current directory
        //   kodo run "<task>"       One task, non-interactive.
        // Only the part before that gap is the command. Stripping the `kodo`
        // prefix first would consume the gap along with it, and the prose would
        // then be read as arguments — which is what produced "kodo Interactive".
        const command = raw
          .split(/\s{2,}/)[0]
          .replace(/^kodo\s*/, "")
          .replace(/\s*#.*$/, "")            // trailing comment
          .replace(/\s*(&&|\|\||\|).*$/, "") // shell operators
          .replace(/[.,;:]+$/, "")
          .trim();
        found.push({ file: rel, line: i + 1, raw: command });
      }
    });
  }
  return found;
}

// Placeholders in a usage synopsis, not literal input:
//   <id>  "value"  $VAR  UPPERCASE  ...  [list|rm <id>]
const PLACEHOLDER = /^[<"'$[(]|^[A-Z_]+$|^\.\.\.$/;

// ── Run ──────────────────────────────────────────────────────────────────────

console.log("\n📦 documentation vs implementation\n");

const commands = implementedCommands();
const flags = implementedFlags();
const subcommands = implementedSubcommands();
const invocations = documentedInvocations();

console.log(`  (${invocations.length} documented \`kodo\` invocations across ${docFiles().length} files)\n`);

// 1 + 2: every documented command and flag exists.
const badCommands = new Map();
const badFlags = new Map();
const documented = new Set();

for (const { file, line, raw } of invocations) {
  const parts = raw.split(/\s+/).filter(Boolean);
  const cmd = parts[0];

  // Bare `kodo` is the interactive session, not a command name.
  if (!cmd) continue;

  // `kodo --version`, `kodo --help` etc. are the bare form.
  if (cmd.startsWith("-")) {
    if (!["--version", "-v", "--help", "-h", "--debug", "--verbose", "--no-color"].includes(cmd)) {
      badFlags.set(`${file}:${line}`, `global flag ${cmd} is not recognised`);
    }
    continue;
  }
  if (PLACEHOLDER.test(cmd)) continue;

  checked++;
  documented.add(cmd);

  if (!commands.has(cmd)) {
    badCommands.set(`${file}:${line}`, `\`kodo ${cmd}\` is documented but not implemented`);
    continue;
  }

  // Subcommand, when this command has a fixed set.
  const sub = parts[1];
  if (sub && !sub.startsWith("-") && !PLACEHOLDER.test(sub) && subcommands[cmd]) {
    if (!subcommands[cmd].has(sub)) {
      badCommands.set(`${file}:${line}`, `\`kodo ${cmd} ${sub}\` — "${sub}" is not a subcommand of ${cmd}`);
    }
  }

  // Flags.
  const fileKey = COMMAND_FILE[cmd];
  const accepted = fileKey ? flags[fileKey] : null;
  if (!accepted) continue;
  for (const part of parts.slice(1)) {
    if (!part.startsWith("--")) continue;
    const name = part.replace(/^--(no-)?/, "").split("=")[0];
    if (!name || PLACEHOLDER.test(name)) continue;
    if (!accepted.has(name)) {
      badFlags.set(`${file}:${line}:${name}`, `\`kodo ${cmd} --${name}\` — not accepted by ${fileKey}.mjs`);
    }
  }
}

if (badCommands.size === 0) ok(`every documented command exists (${checked} invocations checked)`);
else for (const v of badCommands.values()) problem(v);

if (badFlags.size === 0) ok("every documented flag is accepted by its command");
else for (const v of badFlags.values()) problem(v);

// 3: every implemented command is documented.
const undocumented = [...commands].filter((c) => !documented.has(c) && !["ls", "serve"].includes(c));
if (undocumented.length === 0) ok("every implemented command appears in the documentation");
else problem(`implemented but undocumented: ${undocumented.join(", ")}`);

// 4: no fabricated release URLs in user-facing instructions.
const fabricated = [];
for (const file of docFiles()) {
  const text = fs.readFileSync(file, "utf-8");
  text.split("\n").forEach((line, i) => {
    // A curl-pipe-to-shell against a Kodo host is the specific claim that must
    // not appear while no such host exists.
    if (/curl[^\n]*kodo\.dev[^\n]*\|\s*sh/.test(line)) {
      fabricated.push(`${path.relative(REPO, file)}:${i + 1}  quick-start pipes from a host that does not exist`);
    }
  });
}
if (fabricated.length === 0) ok("no quick-start instructions point at a non-existent release host");
else for (const f of fabricated) problem(f);

console.log(`\n${failures === 0 ? "documentation matches the implementation" : `${failures} problem(s)`}\n`);
process.exit(failures > 0 ? 1 : 0);
