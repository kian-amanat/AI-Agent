/**
 * src/commands/init.mjs — `kodo init`.
 *
 * Creates `.kodo/` and generates `KODO.md` using the SAME pipeline the web
 * app's `/init` slash command uses: collectProjectEvidence reads real
 * repository files, generateValidatedKodoMd generates → validates → repairs,
 * and a draft that makes claims the evidence does not support is discarded
 * rather than written. Reimplementing a looser version here would mean two
 * different KODO.md documents depending on which surface you ran it from.
 *
 * Existing configuration is never clobbered: an existing .kodo/settings.json is
 * left exactly as it is, and an existing KODO.md needs --force.
 */

import fs from "fs";
import path from "path";

import { parseArgs } from "../args.mjs";
import { EXIT, usageError, CliError } from "../exit.mjs";
import { resolveConfig } from "../config.mjs";
import { buildModelRoute, inspectModelRoute } from "../creds.mjs";
import { detectWorkspace, displayPath } from "../workspace.mjs";
import { loadCore } from "../core.mjs";
import { projectKodoDir, projectInstructions, projectSettingsPath } from "../paths.mjs";
import { log, style, ok, warn, spinner } from "../term.mjs";

const SPEC = {
  cwd:          { type: "string" },
  force:        { type: "boolean" },
  instructions: { type: "boolean", default: true },
  model:        { type: "string" },
  help:         { type: "boolean", short: "h" },
  color:        { type: "boolean", default: true },
  verbose:      { type: "boolean" },
  debug:        { type: "boolean" },
};

const STARTER_SETTINGS = {
  $schema: "https://kodo.dev/schema/settings.json",
  kodo: {
    // Project-level overrides of CLI configuration. Never put an API key here —
    // this file belongs in version control; credentials belong in ~/.kodo.
    permission: "auto",
  },
  permissions: {},
  hooks: {},
  mcpServers: {},
};

export async function initCommand({ argv }) {
  const { flags } = parseArgs(argv, SPEC);
  const workspace = detectWorkspace(flags.cwd);
  if (!workspace.exists) throw usageError(`Directory does not exist: ${workspace.path}`);

  log("");
  log(`Initialising Kodo in ${style.bold(displayPath(workspace.path))}`);
  log("");

  // 1. .kodo/ — created if absent, never overwritten.
  const kodoDir = projectKodoDir(workspace.path);
  fs.mkdirSync(path.join(kodoDir, "commands"), { recursive: true });
  fs.mkdirSync(path.join(kodoDir, "skills"), { recursive: true });
  fs.mkdirSync(path.join(kodoDir, "agents"), { recursive: true });

  const settingsPath = projectSettingsPath(workspace.path);
  if (fs.existsSync(settingsPath)) {
    log(`  ${style.dim("·")} .kodo/settings.json already exists — left unchanged`);
  } else {
    fs.writeFileSync(settingsPath, `${JSON.stringify(STARTER_SETTINGS, null, 2)}\n`);
    ok(".kodo/settings.json");
  }

  if (!flags.instructions) {
    log("");
    log(style.dim("  Skipped KODO.md (--no-instructions)."));
    return EXIT.OK;
  }

  // 2. KODO.md — the expensive, model-backed part.
  const kodoMd = projectInstructions(workspace.path);
  if (fs.existsSync(kodoMd) && !flags.force) {
    log(`  ${style.dim("·")} KODO.md already exists — left unchanged (use --force to regenerate)`);
    log("");
    return EXIT.OK;
  }

  const { config } = resolveConfig({ workspace: workspace.path, cliFlags: { model: flags.model } });

  // KODO.md is the only model-backed part of `init`, and it is optional. On a
  // fresh machine there is no provider yet, and `buildModelRoute` throws — so
  // `kodo init` exited 3 having ALREADY written .kodo/, leaving a half-made
  // project behind an error message. That is the first command a new user runs
  // after installing, and it looked like Kodo was broken.
  //
  // The project IS initialised at this point: settings, commands, skills and
  // agents all exist and are what the rest of Kodo reads. Say what was skipped
  // and how to get it, and exit OK. A missing provider still fails loudly where
  // it actually matters — `kodo run`, which cannot do anything without one.
  const route = inspectModelRoute(config);
  if (!route.ok) {
    log("");
    log(style.dim("  Skipped KODO.md — no model is configured yet."));
    log(style.dim("  Configure one, then run `kodo init` again to generate it:"));
    log(style.dim("    kodo config set model <model-name>   (or set DEFAULT_MODEL)"));
    log("");
    return EXIT.OK;
  }

  const modelRoute = buildModelRoute(config);
  const core = await loadCore();

  const spin = spinner("inspecting the repository…").start();
  try {
    const tree = await core.walkWorkspace(workspace.path, 6);
    const { collectProjectEvidence, evidenceFooter, generateValidatedKodoMd } = await core.projectEvidence();
    const evidence = await collectProjectEvidence(workspace.path, { tree });

    spin.update(`generating KODO.md from ${evidence.filesInspected.length} inspected file(s)…`);

    const outcome = await generateValidatedKodoMd({
      evidence,
      generate: async ({ system, user }) => {
        const result = await core.callModel({
          system,
          messages: [{ role: "user", content: user }],
          modelRoute,
          maxTokens: 2500,
          temperature: 0.2,
        });
        return String(result?.content || "");
      },
    });

    spin.stop();

    if (!outcome.ok) {
      // Retries exhausted. A stale KODO.md beats one with claims the repository
      // does not support, so nothing is written.
      warn(`could not generate a valid KODO.md after ${outcome.attemptsUsed} attempt(s) — nothing was written.`);
      for (const v of outcome.violations.slice(0, 6)) log(style.dim(`    · ${v.detail}`));
      log("");
      log(style.dim("  Write KODO.md by hand, or try again."));
      return EXIT.TASK_FAILURE;
    }

    fs.writeFileSync(kodoMd, `${outcome.content}\n${evidenceFooter(evidence)}\n`);
    ok(`KODO.md — validated against ${evidence.filesInspected.length} inspected file(s)`);
    if (outcome.attemptsUsed > 1) {
      log(style.dim(`    (validation rejected ${outcome.attemptsUsed - 1} earlier draft(s))`));
    }
    if (evidence.excludedWorktrees?.length) {
      log(style.dim(`    (excluded ${evidence.excludedWorktrees.length} git worktree(s) — not part of this project)`));
    }

    log("");
    log(`  Kodo is ready. Run ${style.cyan("kodo")} to start.`);
    log("");
    return EXIT.OK;
  } catch (err) {
    spin.stop();
    if (err instanceof CliError) throw err;
    throw new CliError(`Could not generate KODO.md: ${err.message}`, EXIT.TASK_FAILURE);
  }
}
