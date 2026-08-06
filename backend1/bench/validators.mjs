/**
 * bench/validators.mjs
 * Runs a benchmark's validator against the REAL post-run workspace.
 *
 * The rule this module exists to enforce: a benchmark is scored from what is
 * on disk, not from what the agent said it did. Validators therefore get
 * filesystem/command helpers as their primary tool, and the agent's own
 * self-report (`run.finalAnswer`, `run.editedFiles`, its todo list) is exposed
 * only so a validator can explicitly check for DISHONESTY — never as evidence
 * that work happened.
 *
 * A validator that throws is a harness fault, not a failed benchmark: it
 * surfaces as a `blocker`, and a blocker is never scored as a pass.
 */

import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/** Helpers handed to every validator. Everything is workspace-relative. */
export function createValidatorHelpers(workspace) {
  const resolve = (rel) => {
    const abs = path.resolve(workspace, rel);
    // A validator reaching outside its workspace would be scoring the wrong
    // tree entirely — almost certainly a bug in the benchmark.
    if (abs !== workspace && !abs.startsWith(workspace + path.sep)) {
      throw new Error(`validator path escapes the workspace: ${rel}`);
    }
    return abs;
  };

  const helpers = {
    workspace,
    resolve,

    async exists(rel) {
      try {
        await fs.access(resolve(rel));
        return true;
      } catch {
        return false;
      }
    },

    async read(rel) {
      try {
        return await fs.readFile(resolve(rel), "utf-8");
      } catch {
        return null;
      }
    },

    async readJson(rel) {
      const raw = await helpers.read(rel);
      if (raw === null) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },

    /** Every file in the tree, POSIX-relative and sorted. */
    async listFiles(subdir = ".") {
      const rootDir = resolve(subdir);
      const out = [];
      async function walk(dir, rel) {
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const ent of entries) {
          if (ent.name === "node_modules" || ent.name === ".git") continue;
          const next = rel ? `${rel}/${ent.name}` : ent.name;
          if (ent.isDirectory()) await walk(path.join(dir, ent.name), next);
          else if (ent.isFile()) out.push(next);
        }
      }
      await walk(rootDir, "");
      return out.sort();
    },

    /** Does any file matching `filter` contain `pattern`? Returns matching paths. */
    async grep(pattern, { filter = () => true, subdir = "." } = {}) {
      const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
      const files = await helpers.listFiles(subdir);
      const hits = [];
      for (const f of files) {
        if (!filter(f)) continue;
        const content = await helpers.read(subdir === "." ? f : `${subdir}/${f}`);
        if (content !== null && re.test(content)) hits.push(f);
      }
      return hits;
    },

    /**
     * Run a real command in the workspace. This is how "the tests actually pass"
     * gets established — the only answer that counts.
     */
    async run(command, { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, env } = {}) {
      return new Promise((resolvePromise) => {
        execFile(
          process.env.SHELL || "/bin/sh",
          ["-c", command],
          {
            cwd: workspace,
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, ...env, NO_COLOR: "1", CI: "1" },
          },
          (err, stdout, stderr) => {
            resolvePromise({
              ok: !err,
              code: err?.code ?? 0,
              timedOut: !!err?.killed,
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? ""),
              output: `${stdout ?? ""}${stderr ?? ""}`,
            });
          }
        );
      });
    },

    /** Sugar for building a check result. `critical` defaults to true. */
    check(name, pass, detail = "", { critical = true } = {}) {
      return { name, pass: !!pass, detail: pass ? "" : String(detail), critical };
    },
  };

  return helpers;
}

/** Coerce whatever a validator returned into the canonical check shape. */
export function normalizeChecks(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.checks) ? raw.checks : null;
  if (!list) throw new Error("validator must return an array of checks (or { checks: [...] })");
  return list.map((c, i) => {
    if (!c || typeof c !== "object") throw new Error(`check #${i} is not an object`);
    if (typeof c.name !== "string" || !c.name.trim()) throw new Error(`check #${i} has no name`);
    if (typeof c.pass !== "boolean") throw new Error(`check "${c.name}" has a non-boolean \`pass\``);
    return {
      name: c.name,
      pass: c.pass,
      detail: c.pass ? "" : String(c.detail ?? ""),
      // Optional checks describe quality, not correctness: they pull a run down
      // to `partial`, but never all the way to `fail` on their own.
      critical: c.critical !== false,
      // A guard asserts that something which was ALREADY true is still true —
      // the fixture still parses, the pre-existing route still works, the file
      // it was told not to touch is untouched. Breaking a guard fails the run,
      // but satisfying one is not progress: an agent that did nothing at all
      // satisfies every guard in the benchmark, and calling that `partial`
      // would dress up a complete no-op as half a success.
      guard: c.guard === true,
    };
  });
}

/**
 * Execute a benchmark's validator.
 * @returns {{checks: Array, blocker: null|{stage:string,message:string}}}
 */
export async function runValidator(benchmark, { workspace, run }) {
  let mod;
  try {
    // Cache-busted so a rerun in the same process picks up an edited validator.
    mod = await import(`${new URL(`file://${benchmark.validatorPath}`).href}?t=${Date.now()}`);
  } catch (err) {
    return { checks: [], blocker: { stage: "validator_load", message: `could not load validator.mjs: ${err.message}` } };
  }

  const validate = mod.default ?? mod.validate;
  if (typeof validate !== "function") {
    return { checks: [], blocker: { stage: "validator_load", message: "validator.mjs must default-export a function" } };
  }

  const helpers = createValidatorHelpers(workspace);
  try {
    const raw = await validate({ workspace, run, helpers, benchmark });
    const checks = normalizeChecks(raw);
    // A validator that asserts nothing would score every run as a vacuous
    // pass. That is a broken benchmark, and it must say so out loud.
    if (!checks.some((c) => c.critical && !c.guard)) {
      return {
        checks,
        blocker: {
          stage: "validator_run",
          message: "validator produced no critical non-guard checks — guards alone cannot establish that the task was done",
        },
      };
    }
    return { checks, blocker: null };
  } catch (err) {
    return {
      checks: [],
      blocker: { stage: "validator_run", message: `validator threw: ${err?.message ?? err}` },
    };
  }
}
