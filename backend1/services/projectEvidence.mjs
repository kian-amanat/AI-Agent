/**
 * services/projectEvidence.mjs
 *
 * Evidence collection for `/init`, so the generated KODO.md describes the
 * repository that is actually on disk rather than a plausible-sounding one.
 *
 * THE DISTINCTION THIS FILE ENFORCES
 *
 *   PROJECT DATA  — the user's source: manifests, configs, README, file tree.
 *                   The only admissible evidence for KODO.md.
 *   RUNTIME DATA  — Kodo's own introspection: memory topics, skills, subagents,
 *                   hooks, MCP registries, and anything under `.kodo/`.
 *                   NEVER evidence about the user's project.
 *
 * Those two were previously easy to blur, because both are "things Kodo can
 * see". A memory topic saying "the backend is Fastify" is a record of a past
 * conversation, not a fact about the repository — treating it as evidence is
 * how a stale assumption becomes an asserted claim in project instructions.
 *
 * Everything here reads real files. A technology is only ever reported when a
 * manifest actually names it; anything weaker is returned as an INFERENCE with
 * its basis attached, so the writer can label it instead of asserting it.
 */

import path from "path";
import { promises as fs } from "fs";
import { execFile } from "child_process";

import { activeWorktrees } from "./worktreeManager.mjs";

// Directories that are Kodo's own state, not the user's project. `.kodo` is
// already excluded by walkWorkspace; repeated here so this module is correct
// on its own rather than by inheritance.
export const RUNTIME_DIRS = new Set([".kodo", ".claude", ".agent-history"]);

// Kodo's introspection surfaces. Their output is never project evidence, and a
// generated KODO.md that talks about them has drifted into describing Kodo.
export const RUNTIME_SURFACES = ["/help", "/memory", "/skills", "/agents", "/hooks", "/mcp", "/commands"];

// Manifests worth reading in full — each one is direct, checkable evidence of
// a technology rather than a guess from a file extension.
const MANIFESTS = [
  "package.json", "tsconfig.json", "deno.json", "bun.lockb",
  "requirements.txt", "pyproject.toml", "setup.py", "Pipfile",
  "go.mod", "Cargo.toml", "Gemfile", "pom.xml", "build.gradle",
  "composer.json", "mix.exs", "pubspec.yaml",
  "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
  "Makefile", "README.md", "readme.md",
];

const MAX_FILE_CHARS = 4_000;
const MAX_MANIFESTS = 12;

function git(args, cwd) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, stdout: String(stdout || "") });
    });
  });
}

/**
 * Every directory under `workspacePath` that is a WORKTREE rather than part of
 * the project. Detection is structural — nothing here matches on a name, so a
 * worktree called `.error-handling-fix` and one called `feature-x` are treated
 * identically.
 *
 * Three independent signals, because each covers a case the others miss:
 *
 *  1. Kodo's own registry (worktreeManager) — worktrees this process created,
 *     even if git has not been consulted yet.
 *  2. `git worktree list --porcelain` — every worktree git knows about,
 *     whoever created it.
 *  3. A `.git` FILE (not directory) at a directory root — the defining
 *     on-disk marker of a linked worktree. This is the ONLY signal that still
 *     works for a DETACHED worktree whose git metadata was pruned but whose
 *     directory remains, which is precisely the orphaned case.
 *
 * Returns workspace-relative paths. A worktree that is later removed simply
 * stops being reported, so that path becomes scannable again with no cache to
 * invalidate.
 */
export async function detectWorktreeRoots(workspacePath, { tree = [] } = {}) {
  const excluded = new Set();
  const root = path.resolve(workspacePath);

  const addIfInside = (abs) => {
    const resolved = path.resolve(abs);
    if (resolved === root) return;                       // the project itself
    const rel = path.relative(root, resolved);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return; // outside
    excluded.add(rel.replace(/\\/g, "/"));
  };

  // (1) Kodo-created worktrees.
  try {
    for (const wt of activeWorktrees()) addIfInside(wt.path);
  } catch { /* manager unavailable — the other signals still apply */ }

  // (2) Anything git reports as a linked worktree.
  const listed = await git(["worktree", "list", "--porcelain"], workspacePath);
  if (listed.ok) {
    for (const line of listed.stdout.split("\n")) {
      if (line.startsWith("worktree ")) addIfInside(line.slice(9).trim());
    }
  }

  // (3) Detached/orphaned worktrees: a `.git` FILE marks a linked worktree
  // root. Checked against the directories already in the tree, so this costs
  // one stat per candidate rather than a second filesystem walk.
  const dirs = tree.filter((f) => f.isDir).map((f) => f.path);
  // The immediate children matter most, but a worktree can be nested; every
  // directory in the (already bounded) tree is checked.
  await Promise.all(dirs.map(async (rel) => {
    if (excluded.has(rel)) return;
    try {
      const st = await fs.stat(path.join(root, rel, ".git"));
      if (st.isFile()) excluded.add(rel);
    } catch { /* no .git marker — ordinary directory */ }
  }));

  return excluded;
}

/** True when `relPath` is inside any excluded worktree root. */
export function isInsideWorktree(relPath, worktreeRoots) {
  const p = String(relPath || "").replace(/\\/g, "/");
  for (const root of worktreeRoots) {
    if (p === root || p.startsWith(`${root}/`)) return true;
  }
  return false;
}

export function isRuntimePath(relPath) {
  const parts = String(relPath || "").replace(/\\/g, "/").split("/");
  return parts.some((p) => RUNTIME_DIRS.has(p));
}

/**
 * Read the manifests that actually exist, plus a bounded file tree.
 *
 * `filesInspected` is the exact provenance list that goes into KODO.md — every
 * claim must be traceable to something in it.
 */
export async function collectProjectEvidence(workspacePath, { tree = [] } = {}) {
  const filesInspected = [];
  const manifests = [];

  // Worktrees are separate checkouts that happen to live on this filesystem.
  // Their manifests describe the SAME project at a different commit, or an
  // unrelated one — either way they are not evidence about this workspace.
  const worktreeRoots = await detectWorktreeRoots(workspacePath, { tree });
  const admissible = (relPath) => !isRuntimePath(relPath) && !isInsideWorktree(relPath, worktreeRoots);

  // Only shallow manifests: a package.json six levels down inside a fixture
  // says nothing about the project's shape.
  const candidates = tree
    .filter((f) => !f.isDir && admissible(f.path))
    .filter((f) => MANIFESTS.includes(path.basename(f.path)))
    .filter((f) => f.path.split("/").length <= 3)
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path))
    .slice(0, MAX_MANIFESTS);

  for (const f of candidates) {
    try {
      const raw = await fs.readFile(path.join(workspacePath, f.path), "utf-8");
      manifests.push({ path: f.path, content: raw.slice(0, MAX_FILE_CHARS), truncated: raw.length > MAX_FILE_CHARS });
      filesInspected.push(f.path);
    } catch { /* unreadable — simply not evidence */ }
  }

  const treePaths = tree
    .filter((f) => admissible(f.path))
    .slice(0, 250)
    .map((f) => (f.isDir ? `${f.path}/` : f.path));

  return {
    workspacePath, filesInspected, manifests, treePaths,
    signals: deriveSignals(manifests),
    excludedWorktrees: [...worktreeRoots].sort(),
  };
}

/**
 * Derive technology signals STRICTLY from manifest contents.
 *
 * Each signal carries the file it came from, so nothing can be asserted
 * without provenance. Absence of a signal means "no evidence", which is very
 * different from "not used" — the caller must not convert one into the other.
 */
export function deriveSignals(manifests) {
  const signals = [];
  const add = (tech, source, basis) => signals.push({ tech, source, basis });

  for (const m of manifests) {
    const base = path.basename(m.path);

    if (base === "package.json") {
      let pkg = null;
      try { pkg = JSON.parse(m.content); } catch { /* truncated or malformed */ }
      if (pkg) {
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        for (const [dep, version] of Object.entries(deps)) {
          add(dep, m.path, `listed in dependencies as "${dep}": "${version}"`);
        }
        if (pkg.scripts) {
          for (const [name, cmd] of Object.entries(pkg.scripts)) {
            add(`script:${name}`, m.path, `npm script "${name}" runs: ${String(cmd).slice(0, 120)}`);
          }
        }
        if (pkg.type) add(`module-type:${pkg.type}`, m.path, `"type": "${pkg.type}"`);
      }
      continue;
    }

    if (base === "go.mod") {
      const mod = m.content.match(/^module\s+(\S+)/m);
      if (mod) add("go", m.path, `go.mod declares module ${mod[1]}`);
      continue;
    }
    if (base === "Cargo.toml") { add("rust", m.path, "Cargo.toml present"); continue; }
    if (base === "requirements.txt" || base === "pyproject.toml" || base === "setup.py" || base === "Pipfile") {
      add("python", m.path, `${base} present`);
      continue;
    }
    if (base === "Gemfile") { add("ruby", m.path, "Gemfile present"); continue; }
    if (base === "pom.xml" || base === "build.gradle") { add("java/jvm", m.path, `${base} present`); continue; }
    if (base === "tsconfig.json") { add("typescript", m.path, "tsconfig.json present"); continue; }
    if (base.startsWith("Dockerfile")) { add("docker", m.path, "Dockerfile present"); continue; }
    if (base.startsWith("docker-compose")) { add("docker-compose", m.path, `${base} present`); continue; }
  }
  return signals;
}

/**
 * Build the /init prompt.
 *
 * The evidence is the ONLY input. The instructions demand provenance and a
 * hard split between verified and inferred, because an unlabelled guess in a
 * file the agent loads on every request becomes a durable false belief.
 */
export function buildInitPrompt(evidence) {
  const manifestBlock = evidence.manifests.length
    ? evidence.manifests.map((m) => `--- ${m.path}${m.truncated ? " (truncated)" : ""} ---\n${m.content}`).join("\n\n")
    : "(no manifest files found)";

  const system = [
    "You write KODO.md — standing project instructions an AI coding agent loads on every request.",
    "",
    "EVIDENCE RULES (these override any instinct to be helpful or complete):",
    "- The file tree and manifest contents below are your ONLY evidence.",
    "- Never state a framework, language, database, or deployment target unless a",
    "  manifest below actually names it. A directory called `api/` is not evidence",
    "  of a backend framework; a file named `Dockerfile` is not evidence of a",
    "  deployment platform.",
    "- If you are not certain, say so explicitly rather than asserting it.",
    "- Never describe Kodo itself. Do not mention Kodo commands, hooks, skills,",
    "  subagents, MCP servers, memory topics, or anything under .kodo/ — those are",
    "  the agent's runtime, not this project.",
    "- Do not invent scripts, commands, or conventions that are not in the evidence.",
    "",
    "REQUIRED STRUCTURE (use these exact headings):",
    "# <project name>",
    "## Verified facts",
    "  Bullets. Each MUST cite its source file in backticks, e.g.",
    "  `- Backend uses Fastify (\\`backend1/package.json\\` dependency \"fastify\")`",
    "## Inferred (unverified)",
    "  Bullets for anything you believe but cannot cite. Each MUST begin with",
    "  \"Likely\" or \"Possibly\" and state what would confirm it. Write",
    "  \"- None.\" if you have nothing to infer.",
    "## Layout",
    "  Which directory is which, from the tree only.",
    "## Commands",
    "  ONLY scripts that appear verbatim in a manifest. Write \"- None found.\"",
    "  if there are none.",
    "## Conventions",
    "  Only what the evidence shows. Omit the section if there is nothing.",
    "",
    "Max ~120 lines of markdown. No filler, no praise, no speculation outside the",
    "Inferred section.",
  ].join("\n");

  const user = [
    `Workspace: ${path.basename(evidence.workspacePath || "") || "(unnamed)"}`,
    "",
    `## Files inspected (${evidence.filesInspected.length})`,
    evidence.filesInspected.length ? evidence.filesInspected.map((f) => `- ${f}`).join("\n") : "- (none)",
    "",
    "## File tree",
    evidence.treePaths.join("\n") || "(empty)",
    "",
    "## Manifest contents",
    manifestBlock,
    "",
    "Write the KODO.md content now (markdown only, no code fence).",
  ].join("\n");

  return { system, user };
}

/**
 * Extract the bullet sentences of a named section.
 * Section ends at the next `## ` heading.
 */
export function extractSection(text, heading) {
  // `$` with /m stops at a LINE end, and \Z is Python syntax that JS treats as
  // a literal "Z" — either mistake makes the FINAL section unmatchable.
  // `(?=\n##\s|$(?![\s\S]))` terminates at the next heading or true EOF.
  const re = new RegExp(
    `^##[ \\t]+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\n([\\s\\S]*?)(?=\\n##[ \\t]|$(?![\\s\\S]))`,
    "m",
  );
  const m = String(text || "").match(re);
  if (!m) return [];
  return m[1].split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("-") || l.startsWith("*"))
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

// A claim that asserts a runnable command, script, build step, deployment or
// workflow. These are the claims that must never be inferred: a fabricated
// build command is actively harmful, unlike a vague description.
const COMMAND_CLAIM_RE = new RegExp(
  [
    "\\b(npm|pnpm|yarn|bun|npx|node|python3?|pip|go|cargo|make|docker|kubectl|terraform|deno)\\b",
    // Inflected forms matter: "is deployed via CI" is as much a workflow claim
    // as "deploy via CI", and the bare stems missed every past tense.
    "\\b(run|build|deploy|start|test|lint|typecheck|migrate|compile|publish)(s|d|ed|ing|ment)?\\b",
  ].join("|"),
  "i",
);

/**
 * BUG 2 — a "Verified facts" bullet is verified ONLY if EVERY checkable claim
 * inside it traces to inspected evidence.
 *
 * A sentence is never partially verified. The failure this fixes: a bullet
 * saying `Frontend uses Node.js because package.json contains
 * "npm install --prefix frontend"` cites a real file but quotes a command
 * that does not appear in it. The file citation passed; the fabricated command
 * rode along with it.
 *
 * Rules applied to every bullet under "Verified facts":
 *   • every `backtick` token that looks like a FILE must be in filesInspected;
 *   • every `backtick` token that looks like a COMMAND must appear VERBATIM in
 *     some inspected file's content;
 *   • a bullet asserting a command/script/build/deploy with no backtick
 *     evidence at all is unverifiable by construction.
 */
export function verifyClaims(text, evidence) {
  const violations = [];
  const inspected = new Set(evidence?.filesInspected || []);
  const treeSet = new Set((evidence?.treePaths || []).map((p) => p.replace(/\/$/, "")));
  const corpus = (evidence?.manifests || []).map((m) => m.content).join("\n");

  for (const bullet of extractSection(text, "Verified facts")) {
    const tokens = [...bullet.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
    const fileTokens = tokens.filter((t) => /\.[a-z0-9]{1,8}$/i.test(t) && !/\s/.test(t));
    const commandTokens = tokens.filter((t) => !fileTokens.includes(t) && COMMAND_CLAIM_RE.test(t));

    for (const f of fileTokens) {
      if (!inspected.has(f) && !treeSet.has(f)) {
        // Reported as a distinct kind: in Verified, a bad citation invalidates
        // the WHOLE bullet, which is stronger than the document-wide notice.
        violations.push({ kind: "unverified-verified-claim", detail: `verified claim cites "${f}", which was not inspected — move the whole bullet to Inferred or remove it: "${bullet.slice(0, 80)}"` });
      }
    }

    // A quoted command must exist verbatim in something that was read.
    for (const cmd of commandTokens) {
      if (!corpus.includes(cmd)) {
        violations.push({ kind: "fabricated-command", detail: `verified claim quotes command \`${cmd}\` which appears in no inspected file — never infer commands: "${bullet.slice(0, 80)}"` });
      }
    }

    // Asserting a command/build/deploy with nothing quoted cannot be checked,
    // so it cannot be "verified".
    if (!tokens.length && COMMAND_CLAIM_RE.test(bullet)) {
      violations.push({ kind: "uncited-claim", detail: `verified claim asserts a command/workflow with no cited evidence — move to Inferred: "${bullet.slice(0, 80)}"` });
    }
  }

  // The Inferred section must actually hedge; an assertion there is just an
  // unverified claim wearing a different hat.
  for (const bullet of extractSection(text, "Inferred (unverified)")) {
    if (/^none\.?$/i.test(bullet)) continue;
    if (!/^(likely|possibly)\b/i.test(bullet)) {
      violations.push({ kind: "unhedged-inference", detail: `inferred claim must begin with "Likely" or "Possibly": "${bullet.slice(0, 80)}"` });
    }
  }

  return violations;
}

/**
 * Post-generation guard.
 *
 * Catches the two failure modes that matter: describing Kodo's runtime instead
 * of the project, and omitting the verified/inferred split that makes a claim
 * checkable. Returns violations rather than silently rewriting — the caller
 * decides, and the user sees why.
 */
export function validateKodoMd(content, evidence) {
  const text = String(content || "");
  const violations = [];

  for (const surface of RUNTIME_SURFACES) {
    // Word-boundary match so "/mcp" doesn't fire on an unrelated substring.
    if (new RegExp(`(^|[\\s\`(])${surface.replace("/", "\\/")}\\b`).test(text)) {
      violations.push({ kind: "runtime-leak", detail: `mentions the Kodo runtime surface "${surface}"` });
    }
  }
  for (const dir of RUNTIME_DIRS) {
    if (new RegExp(`(^|[\\s\`(/])${dir.replace(".", "\\.")}\\/`).test(text)) {
      violations.push({ kind: "runtime-leak", detail: `references the Kodo runtime directory "${dir}/"` });
    }
  }
  for (const word of ["subagent", "MCP server", "hook event", "memory topic"]) {
    if (new RegExp(`\\b${word}`, "i").test(text)) {
      violations.push({ kind: "runtime-leak", detail: `describes Kodo runtime concept "${word}"` });
    }
  }

  if (!/^##\s+Verified facts/m.test(text)) {
    violations.push({ kind: "missing-section", detail: 'missing "## Verified facts" section' });
  }
  if (!/^##\s+Inferred \(unverified\)/m.test(text)) {
    violations.push({ kind: "missing-section", detail: 'missing "## Inferred (unverified)" section' });
  }

  // Document-wide citation check: a fabricated file reference is wrong in ANY
  // section, not just under "Verified facts". Kept alongside the stricter
  // per-sentence rules below so scoping those did not weaken the guard.
  const inspected = new Set(evidence?.filesInspected || []);
  const treeSet = new Set((evidence?.treePaths || []).map((p) => p.replace(/\/$/, "")));
  const seenCitations = new Set();
  for (const m of text.matchAll(/`([^`]+\.(?:json|toml|mod|txt|ya?ml|md|lock))`/g)) {
    const cited = m[1].trim();
    if (seenCitations.has(cited)) continue;
    seenCitations.add(cited);
    if (!inspected.has(cited) && !treeSet.has(cited)) {
      violations.push({ kind: "unverified-citation", detail: `cites "${cited}", which was not inspected` });
    }
  }

  // Sentence-level verification of the Verified/Inferred sections.
  violations.push(...verifyClaims(text, evidence));

  return { ok: violations.length === 0, violations };
}

/** The provenance footer appended to every generated KODO.md. */
export function evidenceFooter(evidence) {
  return [
    "",
    "---",
    `_Generated by \`/init\` on ${new Date().toISOString().slice(0, 10)} from ${evidence.filesInspected.length} inspected file(s):_`,
    ...(evidence.filesInspected.length
      ? evidence.filesInspected.map((f) => `_- \`${f}\`_`)
      : ["_- (no manifest files were found — this document is based on the file tree alone)_"]),
    "_Claims not traceable to those files belong under **Inferred (unverified)**._",
  ].join("\n");
}

// ── BUG 3: generate → validate → repair loop ─────────────────────────────────

export const MAX_INIT_ATTEMPTS = 3;

/**
 * Turn validator output into corrective instructions for the next attempt.
 * Concrete and quoted, so the model repairs the specific bullets rather than
 * rewriting from scratch and reintroducing the same faults.
 */
export function buildRepairPrompt(violations) {
  const byKind = new Map();
  for (const v of violations) {
    if (!byKind.has(v.kind)) byKind.set(v.kind, []);
    byKind.get(v.kind).push(v.detail);
  }
  const lines = [
    "Your previous draft was REJECTED. Fix every problem below and output the",
    "corrected document in full. Do not argue, explain, or apologise — output",
    "markdown only.",
    "",
  ];
  for (const [kind, details] of byKind) {
    lines.push(`### ${kind}`);
    for (const d of details.slice(0, 10)) lines.push(`- ${d}`);
    lines.push("");
  }
  lines.push(
    "Remember:",
    "- A bullet under \"Verified facts\" must have EVERY claim backed by an",
    "  inspected file. If any part is unsupported, move the WHOLE bullet to",
    "  \"Inferred (unverified)\" or delete it. Never split the difference.",
    "- Never invent a command, script, build step or deployment step. Quote only",
    "  strings that appear verbatim in the evidence.",
    "- Every bullet under \"Inferred (unverified)\" must start with \"Likely\" or",
    "  \"Possibly\".",
    "- Never mention Kodo, its commands, hooks, skills, subagents, MCP or .kodo/.",
  );
  return lines.join("\n");
}

/**
 * Generate a KODO.md that PASSES validation, or fail without writing.
 *
 * `generate({ system, user, attempt })` must return the raw model text; it is
 * injected so this loop is testable without a live model.
 *
 * Bounded by MAX_INIT_ATTEMPTS. The loop cannot run forever: `attempt`
 * increments unconditionally and is the only exit condition besides success,
 * so a model that never improves terminates after a fixed number of calls.
 *
 * On exhaustion the caller receives ok:false and MUST NOT write — preserving
 * whatever KODO.md already exists is strictly better than replacing it with a
 * document known to contain unsupported claims.
 */
export async function generateValidatedKodoMd({ evidence, generate, maxAttempts = MAX_INIT_ATTEMPTS }) {
  const { system, user } = buildInitPrompt(evidence);
  const attempts = [];
  let lastViolations = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt = attempt === 1
      ? user
      : `${user}\n\n---\n\n${buildRepairPrompt(lastViolations)}`;

    let raw = "";
    try {
      raw = await generate({ system, user: prompt, attempt });
    } catch (err) {
      attempts.push({ attempt, error: String(err?.message || err), violations: [] });
      lastViolations = [{ kind: "generation-error", detail: String(err?.message || err) }];
      continue;
    }

    const content = String(raw || "")
      .replace(/^```(?:markdown|md)?\n?/, "").replace(/\n?```\s*$/, "").trim();

    if (!content) {
      attempts.push({ attempt, error: "empty response", violations: [] });
      lastViolations = [{ kind: "empty", detail: "the model returned nothing" }];
      continue;
    }

    const { ok, violations } = validateKodoMd(content, evidence);
    attempts.push({ attempt, violations, accepted: ok });
    if (ok) return { ok: true, content, attempts, attemptsUsed: attempt };
    lastViolations = violations;
  }

  return { ok: false, attempts, attemptsUsed: maxAttempts, violations: lastViolations };
}
