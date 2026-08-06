/**
 * bench/corpus.mjs
 * Loads the benchmark corpus from disk.
 *
 * A benchmark is a directory `benchmarks/<family>/<name>/` containing:
 *   prompt.md      — the user message fed to Kodo, verbatim
 *   expected.md    — prose description of the correct outcome (documentation +
 *                    the reference an eyeballing human compares against)
 *   metadata.json  — machine-readable facets (difficulty, capabilities, …)
 *   validator.mjs  — default-exports an async ({workspace, run, helpers}) => checks
 *   workspace/     — optional fixture tree, copied into the isolated workspace
 *
 * A malformed benchmark is NOT silently skipped. It loads as an `invalid`
 * entry carrying its own reason, and the runner turns that into an honest
 * `blocked` result. Silently dropping a broken benchmark is the exact failure
 * mode that makes a suite quietly stop protecting anything.
 */

import fs from "fs/promises";
import path from "path";
import { benchmarksRoot } from "./paths.mjs";

/** Every capability tag a benchmark may claim. Keeps typos from inventing facets. */
export const CAPABILITIES = [
  "implementation",
  "resume",
  "verification",
  "no_progress",
  "thrashing",
  "honest_blocker",
  "multi_file",
  "single_file",
  "question_only",
  "wiring",
];

export const DIFFICULTIES = ["easy", "hard"];

/** Outcomes a benchmark may declare it expects. Mirrors scoring.OUTCOMES. */
export const EXPECTED_OUTCOMES = ["pass", "needs_user", "stopped_early"];

async function readIfExists(file) {
  try {
    return await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
}

async function isDir(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function validateMetadata(meta, id) {
  const problems = [];
  if (!meta || typeof meta !== "object") return [`metadata.json is not an object`];
  if (typeof meta.title !== "string" || !meta.title.trim()) problems.push("metadata.title must be a non-empty string");
  if (!DIFFICULTIES.includes(meta.difficulty)) {
    problems.push(`metadata.difficulty must be one of ${DIFFICULTIES.join(" | ")} (got ${JSON.stringify(meta.difficulty)})`);
  }
  if (typeof meta.golden !== "boolean") problems.push("metadata.golden must be a boolean");
  if (!Array.isArray(meta.capabilities) || meta.capabilities.length === 0) {
    problems.push("metadata.capabilities must be a non-empty array");
  } else {
    for (const c of meta.capabilities) {
      if (!CAPABILITIES.includes(c)) problems.push(`unknown capability ${JSON.stringify(c)} (known: ${CAPABILITIES.join(", ")})`);
    }
  }
  if (meta.expectedOutcome !== undefined && !EXPECTED_OUTCOMES.includes(meta.expectedOutcome)) {
    problems.push(`metadata.expectedOutcome must be one of ${EXPECTED_OUTCOMES.join(" | ")}`);
  }
  if (meta.permissionMode !== undefined && !["auto", "ask", "plan"].includes(meta.permissionMode)) {
    problems.push("metadata.permissionMode must be auto | ask | plan");
  }
  if (meta.timeoutMs !== undefined && (!Number.isInteger(meta.timeoutMs) || meta.timeoutMs <= 0)) {
    problems.push("metadata.timeoutMs must be a positive integer");
  }
  if (meta.fixtureModes !== undefined) {
    if (typeof meta.fixtureModes !== "object" || Array.isArray(meta.fixtureModes)) {
      problems.push("metadata.fixtureModes must be an object of { relativePath: octalString }");
    } else {
      for (const [p, mode] of Object.entries(meta.fixtureModes)) {
        if (!/^0?[0-7]{3,4}$/.test(String(mode))) problems.push(`fixtureModes["${p}"] must be an octal mode string like "0444"`);
      }
    }
  }
  if (meta.askUserAnswer !== undefined && typeof meta.askUserAnswer !== "string") {
    problems.push("metadata.askUserAnswer must be a string");
  }
  if (meta.id !== undefined && meta.id !== id) {
    problems.push(`metadata.id ${JSON.stringify(meta.id)} does not match its directory-derived id ${JSON.stringify(id)}`);
  }
  return problems;
}

async function loadOne(family, name, dir) {
  const id = `${family}/${name}`;
  const invalid = (reason) => ({ id, family, name, dir, valid: false, reason });

  const [promptRaw, expectedRaw, metaRaw] = await Promise.all([
    readIfExists(path.join(dir, "prompt.md")),
    readIfExists(path.join(dir, "expected.md")),
    readIfExists(path.join(dir, "metadata.json")),
  ]);

  if (promptRaw === null) return invalid("missing prompt.md");
  if (!promptRaw.trim()) return invalid("prompt.md is empty");
  if (expectedRaw === null) return invalid("missing expected.md");
  if (metaRaw === null) return invalid("missing metadata.json");

  let metadata;
  try {
    metadata = JSON.parse(metaRaw);
  } catch (err) {
    return invalid(`metadata.json is not valid JSON: ${err.message}`);
  }

  const problems = validateMetadata(metadata, id);
  if (problems.length) return invalid(problems.join("; "));

  const validatorPath = path.join(dir, "validator.mjs");
  if (!(await readIfExists(validatorPath))) return invalid("missing validator.mjs");

  const fixtureDir = path.join(dir, "workspace");
  const hasFixture = await isDir(fixtureDir);

  return {
    id,
    family,
    name,
    dir,
    valid: true,
    reason: null,
    // The prompt is passed to the agent verbatim, minus a trailing newline —
    // benchmark prompts are authored as markdown files, not chat messages.
    prompt: promptRaw.trim(),
    expected: expectedRaw.trim(),
    metadata: {
      difficulty: metadata.difficulty,
      golden: metadata.golden,
      capabilities: [...metadata.capabilities].sort(),
      title: metadata.title,
      expectedOutcome: metadata.expectedOutcome ?? "pass",
      permissionMode: metadata.permissionMode ?? "auto",
      timeoutMs: metadata.timeoutMs ?? 600_000,
      // Git only tracks the executable bit, so a fixture that needs to be
      // genuinely unwritable (to reproduce an EACCES wall) has to declare it.
      fixtureModes: metadata.fixtureModes ?? null,
      // What the harness answers when the agent calls ask_user. The default is
      // "no human is here"; a benchmark about ambiguity wants something
      // stricter, so it can state it.
      askUserAnswer: metadata.askUserAnswer ?? null,
      notes: typeof metadata.notes === "string" ? metadata.notes : "",
    },
    validatorPath,
    fixtureDir: hasFixture ? fixtureDir : null,
  };
}

/**
 * Load every benchmark under `root`. Always returned sorted by id so a run,
 * a report, and a comparison all iterate in the same order — a precondition
 * for the whole thing being reproducible.
 */
export async function loadCorpus({ root = benchmarksRoot } = {}) {
  let families;
  try {
    families = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Benchmark corpus not found at ${root}: ${err.message}`);
  }

  const benchmarks = [];
  for (const famEnt of families.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!famEnt.isDirectory() || famEnt.name.startsWith(".") || famEnt.name.startsWith("_")) continue;
    const famDir = path.join(root, famEnt.name);
    const entries = await fs.readdir(famDir, { withFileTypes: true });
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!ent.isDirectory() || ent.name.startsWith(".") || ent.name.startsWith("_")) continue;
      benchmarks.push(await loadOne(famEnt.name, ent.name, path.join(famDir, ent.name)));
    }
  }
  return benchmarks.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Filter a corpus. Every filter is a narrowing AND; an unmatched explicit id is
 * an error rather than an empty run, so a typo'd `--id` can't look like a pass.
 */
export function selectBenchmarks(corpus, { ids, families, golden, difficulty, capabilities } = {}) {
  let out = corpus;
  if (ids?.length) {
    const wanted = new Set(ids);
    const known = new Set(corpus.map((b) => b.id));
    const missing = ids.filter((i) => !known.has(i));
    if (missing.length) throw new Error(`Unknown benchmark id(s): ${missing.join(", ")}`);
    out = out.filter((b) => wanted.has(b.id));
  }
  if (families?.length) {
    const wanted = new Set(families);
    out = out.filter((b) => wanted.has(b.family));
  }
  if (golden) out = out.filter((b) => !b.valid || b.metadata.golden);
  if (difficulty) out = out.filter((b) => !b.valid || b.metadata.difficulty === difficulty);
  if (capabilities?.length) {
    out = out.filter((b) => !b.valid || capabilities.some((c) => b.metadata.capabilities.includes(c)));
  }
  return out;
}
