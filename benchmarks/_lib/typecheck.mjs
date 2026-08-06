/**
 * benchmarks/_lib/typecheck.mjs
 * A real TypeScript check for validators that need one.
 *
 * There is no `typescript` dependency added for the benchmark suite. This
 * borrows the compiler the repo already has (the Next.js UI's node_modules),
 * exactly the way backend1/utils/syntax.util.mjs does. If no compiler can be
 * found, this reports `available: false` and the validator turns that into an
 * honest BLOCKER — a benchmark that cannot be type-checked must not quietly
 * report a pass.
 */

import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const _require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

let _ts;

export function loadTypeScript() {
  if (_ts !== undefined) return _ts;
  const candidates = [
    path.join(REPO_ROOT, "chatbot/my-chatbot-ui/node_modules/typescript"),
    path.join(REPO_ROOT, "node_modules/typescript"),
    path.join(REPO_ROOT, "backend1/node_modules/typescript"),
  ];
  for (const p of candidates) {
    try { _ts = _require(p); return _ts; } catch { /* try the next one */ }
  }
  _ts = null;
  return null;
}

/**
 * Type-check `files` (absolute paths) under strict mode.
 *
 * `parseOnly` reports syntax errors only. That is the right mode for a fixture
 * whose dependencies are not installed — a two-file TSX fixture with no React
 * types will always produce "cannot find react/jsx-runtime" and "no interface
 * JSX.IntrinsicElements", which say nothing about the agent's work. A check
 * that can never pass is noise, and noise in a benchmark report is how real
 * failures stop being noticed.
 *
 * @returns {{available: boolean, reason?: string, errors: string[]}}
 */
export function typecheck(files, { strict = true, jsx = false, parseOnly = false } = {}) {
  const ts = loadTypeScript();
  if (!ts) {
    return {
      available: false,
      reason:
        "no TypeScript compiler found in this repo (looked in chatbot/my-chatbot-ui/node_modules, " +
        "./node_modules and backend1/node_modules). Install it, or run this benchmark where it is available.",
      errors: [],
    };
  }

  const program = ts.createProgram(files, {
    strict,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: jsx ? ts.JsxEmit.ReactJSX : undefined,
    allowImportingTsExtensions: true,
  });

  const diagnostics = parseOnly
    ? program.getSyntacticDiagnostics()
    : [...program.getSemanticDiagnostics(), ...program.getSyntacticDiagnostics()];

  const errors = diagnostics
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
      if (!d.file) return `TS${d.code}: ${msg}`;
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
      return `${path.basename(d.file.fileName)}(${line + 1},${character + 1}): TS${d.code}: ${msg}`;
    })
    .sort();

  return { available: true, errors };
}
