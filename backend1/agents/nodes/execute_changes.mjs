/**
 * execute_changes.mjs
 * Applies patch plans safely.
 *
 * Supports:
 * - rewrite_file
 * - replace_text
 * - replace_block
 * - insert_before
 * - insert_after
 * - delete_text
 *
 * Also supports the older edits[] array.
 */

import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { AIMessage } from "@langchain/core/messages";
import { callLLM } from "../../services/llm.mjs";

const _require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const HISTORY_ROOT = path.resolve(PROJECT_ROOT, ".agent-history");

let _tsCache = undefined; // undefined = not tried yet; null = not found; otherwise the module

function loadTypeScript() {
  if (_tsCache !== undefined) return _tsCache;
  const candidates = [
    path.join(PROJECT_ROOT, "chatbot/my-chatbot-ui/node_modules/typescript"),
    path.join(PROJECT_ROOT, "node_modules/typescript"),
    path.join(PROJECT_ROOT, "../node_modules/typescript"),
  ];
  for (const p of candidates) {
    try { _tsCache = _require(p); return _tsCache; } catch {}
  }
  _tsCache = null;
  return null;
}

function validateSyntax(content, absPath) {
  const ext = path.extname(absPath).toLowerCase();

  // Python: spawn python3 and parse via ast module
  if (ext === ".py") {
    try {
      const { spawnSync } = _require("child_process");
      const res = spawnSync(
        "python3",
        ["-c", "import ast, sys; ast.parse(sys.stdin.read())"],
        { input: content, encoding: "utf-8", timeout: 5000 }
      );
      if (res.status !== 0) {
        const raw = String(res.stderr || res.stdout || "Python syntax error");
        const errLine = raw.split("\n").filter(l => l.includes("SyntaxError") || l.includes("line")).slice(0, 2).join(" ").trim();
        return errLine || "Python syntax error";
      }
    } catch { /* python3 not available — skip */ }
    return null;
  }

  // CSS/SCSS: patches that anchor mid-rule can slice a declaration in half, leaving
  // orphaned properties and stray closers (this shipped once: a .card-3d block was
  // inserted INSIDE .animate-typing-dot, breaking the whole app's build with
  // "Unexpected }"). A brace-depth scan catches every unbalanced case cheaply.
  if (ext === ".css" || ext === ".scss") {
    let depth = 0;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      // Strip comments and strings crudely — good enough for brace counting
      const line = lines[i].replace(/\/\*[\s\S]*?\*\//g, "").replace(/"[^"]*"|'[^']*'/g, "");
      for (const ch of line) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth < 0) return `L${i + 1}: unexpected "}" — closing brace without a matching open (patch likely landed mid-rule)`;
        }
      }
    }
    if (depth !== 0) return `unbalanced braces: ${depth} unclosed "{" at end of file (patch likely landed mid-rule)`;
    return null;
  }

  if (![".tsx", ".jsx", ".ts", ".js"].includes(ext)) return null;
  const ts = loadTypeScript();
  if (!ts) return null;
  const scriptKind = ext === ".tsx" ? ts.ScriptKind.TSX
                   : ext === ".jsx" ? ts.ScriptKind.JSX
                   : ext === ".ts"  ? ts.ScriptKind.TS
                   : ts.ScriptKind.JS;
  try {
    const srcFile = ts.createSourceFile("validate" + ext, content, ts.ScriptTarget.ESNext, true, scriptKind);
    const diags = srcFile.parseDiagnostics;
    if (Array.isArray(diags) && diags.length > 0) {
      return diags.slice(0, 3).map(d => {
        try {
          const lc = srcFile.getLineAndCharacterOfPosition(d.start || 0);
          const msg = typeof d.messageText === "string" ? d.messageText : d.messageText?.messageText || "parse error";
          return `L${lc.line + 1}: ${msg}`;
        } catch { return "parse error"; }
      }).join("; ");
    }

    // Next.js hard rule: a "use client" file cannot export `metadata` — it always
    // fails the build. Kodo once added 'use client' + scroll hooks to the root
    // layout (which exports metadata) and broke every page in the app at once.
    if (/^\s*["']use client["']/.test(content) && /export\s+const\s+metadata\b/.test(content)) {
      return `"use client" component exports "metadata" — disallowed in Next.js. Keep the file a Server Component or move the client logic (hooks, event handlers) into a separate client component file.`;
    }

    // With the automatic JSX runtime there is no React global: calling React.useRef
    // (etc.) without importing React throws "ReferenceError: React is not defined"
    // at RUNTIME while parsing fine — it once shipped a 500 on a page that passed
    // every static check. Catch it before the write.
    if (/\bReact\.[a-zA-Z]/.test(content) && !/import\s+(?:\*\s+as\s+)?React\b|import\s+React\s*,/.test(content)) {
      const line = content.split("\n").findIndex(l => /\bReact\.[a-zA-Z]/.test(l)) + 1;
      return `L${line}: uses React.<something> but never imports React — add \`import React from 'react'\` or import the hook directly (e.g. \`import { useRef } from 'react'\`).`;
    }

    // Local/alias imports must resolve to real files. During a lint-fix retry the
    // model once "refactored" a component out into '@/components/ui/magnetic-button'
    // — a module it never created — shipping a Module-not-found build break that
    // parse/typegrammar checks can't see. Bare package imports are skipped (npm deps).
    const importErr = checkLocalImportsResolve(content, absPath);
    if (importErr) return importErr;

    // Beyond grammar: catch the mistakes patch-based edits are most prone to.
    // None of these are parse errors — TS happily parses all of them — so they
    // need their own AST walks. Duplicate imports first (applies to all JS/TS):
    // a patch meant to REPLACE an import block often lands as insert_before,
    // leaving the old block in place — 40 "Duplicate identifier" typecheck errors
    // downstream, caught here before the broken content ever reaches disk.
    const dupImport = checkDuplicateImports(ts, srcFile);
    if (dupImport) return dupImport;

    // JSX-only: a prop applied twice on the same element, and a capitalized JSX
    // tag that isn't imported or declared anywhere in the file.
    if (ext === ".tsx" || ext === ".jsx") {
      return checkJsxStructuralIssues(ts, srcFile);
    }

    return null;
  } catch { return null; }
}

// Resolve "./x", "../x", and "@/x" import specifiers against the filesystem the
// way the bundler will. "@/" maps to the file's sub-project root (nearest ancestor
// with a package.json — matches this repo's tsconfig "@/*": ["./*"]). Probes the
// standard extension/index candidates. Bare package names are ignored.
function checkLocalImportsResolve(content, absPath) {
  const IMPORT_RE = /(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const fileDir = path.dirname(absPath);

  let projectRoot = null;
  const specs = [];
  for (const m of content.matchAll(IMPORT_RE)) {
    const spec = m[1] || m[2];
    if (spec && (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("@/"))) specs.push(spec);
  }
  if (specs.length === 0) return null;

  for (const spec of specs) {
    let base;
    if (spec.startsWith("@/")) {
      if (!projectRoot) {
        let dir = fileDir;
        while (dir !== path.dirname(dir)) {
          if (existsSync(path.join(dir, "package.json"))) { projectRoot = dir; break; }
          dir = path.dirname(dir);
        }
      }
      if (!projectRoot) continue; // can't resolve the alias — don't block
      base = path.join(projectRoot, spec.slice(2));
    } else {
      base = path.resolve(fileDir, spec);
    }

    const candidates = [
      base,
      `${base}.tsx`, `${base}.ts`, `${base}.jsx`, `${base}.js`, `${base}.mjs`, `${base}.css`, `${base}.json`,
      path.join(base, "index.tsx"), path.join(base, "index.ts"), path.join(base, "index.js"),
    ];
    if (!candidates.some((c) => existsSync(c))) {
      const line = content.split("\n").findIndex((l) => l.includes(spec)) + 1;
      return `L${line}: import "${spec}" does not resolve to any existing file — either create that module in the same plan (as a create step BEFORE this file is written) or keep the code in this file instead of importing it.`;
    }
  }
  return null;
}

function checkDuplicateImports(ts, srcFile) {
  const seen = new Map(); // imported local name -> first line
  for (const stmt of srcFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const names = [];
    if (stmt.importClause.name) names.push(stmt.importClause.name);
    const bindings = stmt.importClause.namedBindings;
    if (bindings) {
      if (ts.isNamespaceImport(bindings)) names.push(bindings.name);
      else if (ts.isNamedImports(bindings)) {
        for (const spec of bindings.elements) names.push(spec.name);
      }
    }
    for (const nameNode of names) {
      const name = nameNode.text;
      const lc = srcFile.getLineAndCharacterOfPosition(nameNode.getStart(srcFile));
      if (seen.has(name)) {
        return `L${lc.line + 1}: duplicate import "${name}" (already imported at L${seen.get(name)}) — the patch likely added a new import block instead of replacing the existing one`;
      }
      seen.set(name, lc.line + 1);
    }
  }
  return null;
}

function checkJsxStructuralIssues(ts, srcFile) {
  // 1. Duplicate JSX attribute on the same element.
  let dupError = null;
  function visitDup(node) {
    if (dupError) return;
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const seen = new Set();
      for (const attr of node.attributes.properties) {
        if (ts.isJsxAttribute(attr) && attr.name) {
          const name = attr.name.getText(srcFile);
          if (seen.has(name)) {
            const lc = srcFile.getLineAndCharacterOfPosition(attr.getStart(srcFile));
            dupError = `L${lc.line + 1}: duplicate JSX attribute "${name}" on the same element`;
            return;
          }
          seen.add(name);
        }
      }
    }
    ts.forEachChild(node, visitDup);
  }
  visitDup(srcFile);
  if (dupError) return dupError;

  // 2. Capitalized JSX tag used without being imported or declared anywhere in the file.
  // Lowercase tags (div, span, button...) are intrinsic HTML elements — never flagged.
  // Declaration collection is intentionally scope-blind (any declaration anywhere in the
  // file counts) — this is a cheap "did the patch forget an import" check, not a real
  // type-checker, so it should never block a legitimate write on a scoping technicality.
  const declared = new Set([
    "React", "Fragment", "console", "window", "document", "Math", "JSON",
    "Object", "Array", "Promise", "Error", "Date", "Map", "Set",
  ]);
  function collectDeclarations(node) {
    if (ts.isImportClause(node) && node.name) declared.add(node.name.text);
    if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) declared.add(node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declared.add(node.name.text);
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) declared.add(node.name.text);
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) declared.add(node.name.text);
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) declared.add(node.name.text);
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) declared.add(node.name.text);
    if (ts.isExportSpecifier(node)) declared.add((node.propertyName || node.name).text);
    ts.forEachChild(node, collectDeclarations);
  }
  collectDeclarations(srcFile);

  // Collect EVERY undefined component in one pass — reporting only the first sent
  // the fix-forward repair on a whack-a-mole loop (fixed <Lock>, then failed on
  // <History>, task dead). One complete list = one repair pass.
  const undefinedTags = new Map(); // name -> first line
  function visitTag(node) {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName)) {
      const name = node.tagName.text;
      if (/^[A-Z]/.test(name) && !declared.has(name) && !undefinedTags.has(name)) {
        const lc = srcFile.getLineAndCharacterOfPosition(node.getStart(srcFile));
        undefinedTags.set(name, lc.line + 1);
      }
    }
    ts.forEachChild(node, visitTag);
  }
  visitTag(srcFile);

  if (undefinedTags.size > 0) {
    const list = [...undefinedTags.entries()].map(([n, l]) => `<${n}> (L${l})`).join(", ");
    return `components used but never imported or declared: ${list} — add ALL missing imports in one edit (icon names usually come from 'lucide-react').`;
  }
  return null;
}

// ── Fix-forward syntax repair (Claude Code approach) ───────────────────────────
// When a patch produces content that fails pre-write validation, we hold BOTH the
// broken content AND the exact error. Re-planning from scratch throws that away and
// burns a full retry on a fresh guess (observed: two attempts, two DIFFERENT syntax
// errors, task dead). Instead: one targeted LLM call — "here is the file, here is
// the error, fix ONLY that" — then re-validate. Only a clean result gets written.
export async function attemptSyntaxRepair(brokenContent, syntaxErr, relPath, absPath, modelRoute, emit) {
  try {
    emit?.({ type: "progress", stage: "executing", message: `Auto-repairing syntax error in ${path.basename(relPath)}…` });
    console.log(`[Execute] Attempting fix-forward syntax repair for ${relPath}: ${String(syntaxErr).slice(0, 120)}`);

    const maxTokens = Math.min(16_000, Math.max(4096, Math.ceil(brokenContent.length / 3) + 1500));
    const result = await callLLM({
      system: `You repair syntax errors in code files. You receive a file and its exact validation error(s).

STRICT RULES:
- Fix ONLY what the error(s) require — every other line stays byte-for-byte identical.
- Return the ENTIRE corrected file inside ONE code fence. No explanations, no JSON, no truncation, no "rest unchanged" placeholders.
- Common fixes: add a missing import; escape a bare > or < in JSX text as {'>'}/{'<'} or &gt;/&lt;; escape ' in JSX text as &apos;; close an unclosed tag; remove a duplicated attribute or import.`,
      messages: [{
        role: "user",
        content: `File: ${relPath}\nValidation error(s): ${syntaxErr}\n\n\`\`\`\n${brokenContent}\n\`\`\`\n\nReturn the corrected complete file now.`,
      }],
      modelRoute,
      maxTokens,
      temperature: 0,
      stream: true,
    });

    const raw = String(result?.content || "");
    const fence = raw.match(/```(?:\w+)?\s*\n([\s\S]*?)```/);
    let code = fence ? fence[1].trim() : null;
    if (!code && /^(["']use client["']|import\s)/.test(raw.trim())) code = raw.trim();
    if (!code || code.length < brokenContent.length * 0.5) {
      console.warn(`[Execute] Syntax repair rejected: unusable response (${code ? code.length : 0} chars)`);
      return null;
    }

    const stillBroken = validateSyntax(code, absPath);
    if (stillBroken) {
      console.warn(`[Execute] Syntax repair still invalid: ${String(stillBroken).slice(0, 120)}`);
      return null;
    }

    console.log(`[Execute] ✅ Fix-forward syntax repair succeeded for ${relPath}`);
    return code;
  } catch (err) {
    console.warn(`[Execute] Syntax repair failed: ${String(err?.message || err).slice(0, 120)}`);
    return null;
  }
}

function normalizeId(prefix, id) {
  if (!id) return id;
  const p = `${prefix}_`;
  return id.startsWith(p) ? id : `${p}${id}`;
}

function isInsideRoot(root, target) {
  const rel = path.relative(root, target);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function safeResolvePath(root, filePath) {
  if (!filePath || typeof filePath !== "string") {
    throw new Error("Invalid file path");
  }

  if (path.isAbsolute(filePath)) {
    const normalized = path.normalize(filePath);
    if (!isInsideRoot(root, normalized)) {
      throw new Error(`Path escapes workspace: ${filePath}`);
    }
    return normalized;
  }

  const resolved = path.resolve(root, filePath);
  if (!isInsideRoot(root, resolved) && resolved !== root) {
    throw new Error(`Path escapes workspace: ${filePath}`);
  }
  return resolved;
}

function ensureParentDir(absPath) {
  return fs.mkdir(path.dirname(absPath), { recursive: true });
}

async function readFileSafe(absPath) {
  try {
    return await fs.readFile(absPath, "utf-8");
  } catch {
    return null;
  }
}

async function findFileByPartialPath(root, partialPath) {
  const target = String(partialPath || "").replace(/\\/g, "/").trim();
  if (!target) return null;

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }

    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".next" || entry.name === ".agent-history" || entry.name === ".kodo" || entry.name === ".claude") continue;

      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = await walk(abs);
        if (found) return found;
      } else {
        const rel = path.relative(root, abs).replace(/\\/g, "/");
        if (rel === target || rel.endsWith(target)) return abs;
      }
    }

    return null;
  }

  return walk(root);
}

const EXT_LANG = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript",
  cjs: "javascript", py: "python", css: "css", scss: "scss", json: "json",
  md: "markdown", html: "html", yml: "yaml", yaml: "yaml", sh: "bash",
  rs: "rust", go: "go", rb: "ruby", java: "java", php: "php", txt: "text",
};

function langFromPath(filePath) {
  const ext = String(filePath || "").split(".").pop()?.toLowerCase() || "";
  return EXT_LANG[ext] || ext;
}

const HUNK_MAX = 3000;
// Whole-file hunks (rewrite/create/delete) must not be truncated at the same tight
// cap as a single patch's search/replace text — a 700-line full-file rewrite sliced
// to 3000 chars shows the UI only ~100 changed lines, making a legitimate full
// rebuild look like a tiny, wrong patch. Bounded generously, not truncated in practice
// for any realistic single source file.
const REWRITE_HUNK_MAX = 150_000;

function buildDiffHunk(patch, original, working) {
  const { kind, search, replace, content, anchor, before, after } = patch;
  switch (kind) {
    case "rewrite_file":
      return { kind: "rewrite", before: original.slice(0, REWRITE_HUNK_MAX), after: working.slice(0, REWRITE_HUNK_MAX) };
    case "replace_text":
    case "replace_block":
      return { kind: "replace", before: search.slice(0, HUNK_MAX), after: replace.slice(0, HUNK_MAX) };
    case "insert_before":
      return { kind: "insert", after: (before || content).slice(0, HUNK_MAX), anchor: anchor.slice(0, 200) };
    case "insert_after":
      return { kind: "insert", after: (after || content).slice(0, HUNK_MAX), anchor: anchor.slice(0, 200) };
    case "delete_text":
      return { kind: "delete", before: search.slice(0, HUNK_MAX) };
    default:
      return null;
  }
}

export async function writeFileAtomic(absPath, content) {
  await ensureParentDir(absPath);
  const tmpPath = `${absPath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, absPath);
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trimEnd();
}

function findUniqueExact(content, needle) {
  const idx = content.indexOf(needle);
  if (idx === -1) return { ok: false, error: "search text not found" };

  const lastIdx = content.lastIndexOf(needle);
  if (lastIdx !== idx) {
    return { ok: false, error: "search text is not unique" };
  }

  return { ok: true, index: idx };
}

function findUniqueNormalizedBlock(content, needle) {
  const normalizedNeedle = normalizeText(needle);
  if (!normalizedNeedle) return { ok: false, error: "empty search text" };

  const lines = String(content || "").split("\n");
  const needleLines = normalizedNeedle.split("\n").map((l) => l.trim()).filter(Boolean);

  if (needleLines.length === 0) return { ok: false, error: "empty search text" };

  const matches = [];

  for (let start = 0; start < lines.length; start++) {
    let si = 0;
    let end = start;

    while (end < lines.length && si < needleLines.length) {
      const current = lines[end].trim();
      if (current === "" && needleLines[si] !== "") {
        end++;
        continue;
      }

      // Allow the last needle line to be a prefix of the file line — models often
      // truncate the anchor mid-line (e.g. "<Image s" instead of the full attribute list).
      const isLastNeedle = si === needleLines.length - 1;
      const lineMatches = isLastNeedle
        ? current.startsWith(needleLines[si])
        : current === needleLines[si];

      if (lineMatches) {
        si++;
        end++;
      } else {
        break;
      }
    }

    if (si === needleLines.length) {
      matches.push({ start, end });
    }
  }

  if (matches.length === 0) return { ok: false, error: "block not found" };
  if (matches.length > 1) return { ok: false, error: "search text is not unique" };
  return { ok: true, start: matches[0].start, end: matches[0].end };
}

function applyReplaceText(content, search, replace) {
  if (typeof search !== "string" || !search.trim()) {
    return { ok: false, content, error: "empty search" };
  }

  const exact = findUniqueExact(content, search);
  if (exact.ok) {
    const newContent =
      content.slice(0, exact.index) +
      replace +
      content.slice(exact.index + search.length);

    return { ok: true, content: newContent, error: null, note: "exact match" };
  }

  const block = findUniqueNormalizedBlock(content, search);
  if (block.ok) {
    const lines = content.split("\n");
    const indent = lines[block.start]?.match(/^(\s*)/)?.[1] || "";
    const replacementLines = String(replace || "")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => (line.length ? indent + line.replace(/^\s+/, "") : line));

    lines.splice(block.start, block.end - block.start, ...replacementLines);
    return {
      ok: true,
      content: lines.join("\n"),
      error: null,
      note: "normalized block match",
    };
  }

  return { ok: false, content, error: "search text not found" };
}

function applyInsertBefore(content, anchor, insertText) {
  if (!anchor || !String(anchor).trim()) {
    return { ok: false, content, error: "missing anchor" };
  }

  const idx = content.indexOf(anchor);
  if (idx === -1) return { ok: false, content, error: "anchor not found" };

  const lastIdx = content.lastIndexOf(anchor);
  if (lastIdx !== idx) return { ok: false, content, error: "anchor is not unique" };

  return {
    ok: true,
    content: content.slice(0, idx) + insertText + content.slice(idx),
    error: null,
  };
}

function applyInsertAfter(content, anchor, insertText) {
  if (!anchor || !String(anchor).trim()) {
    return { ok: false, content, error: "missing anchor" };
  }

  const idx = content.indexOf(anchor);
  if (idx === -1) return { ok: false, content, error: "anchor not found" };

  const lastIdx = content.lastIndexOf(anchor);
  if (lastIdx !== idx) return { ok: false, content, error: "anchor is not unique" };

  const insertAt = idx + anchor.length;
  return {
    ok: true,
    content: content.slice(0, insertAt) + insertText + content.slice(insertAt),
    error: null,
  };
}

function applyDeleteText(content, search) {
  return applyReplaceText(content, search, "");
}

function applyRewriteFile(_content, nextContent) {
  return {
    ok: true,
    content: String(nextContent || ""),
    error: null,
    note: "rewrite_file",
  };
}

function normalizePatch(patch) {
  if (!patch || typeof patch !== "object") return null;

  const kind = String(patch.kind || patch.type || "").trim();
  if (!kind) return null;

  return {
    kind,
    search: String(patch.search || patch.anchor || patch.before || "").trim(),
    replace: String(patch.replace || patch.content || patch.after || "").replace(/\r\n/g, "\n"),
    content: String(patch.content || "").replace(/\r\n/g, "\n"),
    anchor: String(patch.anchor || "").trim(),
    before: String(patch.before || "").replace(/\r\n/g, "\n"),
    after: String(patch.after || "").replace(/\r\n/g, "\n"),
  };
}

function extractPatches(step) {
  const patches = [];

  if (Array.isArray(step?.patches)) {
    for (const p of step.patches) {
      const normalized = normalizePatch(p);
      if (normalized) patches.push(normalized);
    }
  }

  if (Array.isArray(step?.edits)) {
    for (const e of step.edits) {
      if (!e || typeof e !== "object") continue;
      if (typeof e.search !== "string" || typeof e.replace !== "string") continue;
      patches.push({
        kind: "replace_text",
        search: e.search,
        replace: e.replace,
        content: "",
        anchor: "",
        before: "",
        after: "",
      });
    }
  }

  return patches;
}

function applyOnePatch(content, patch) {
  switch (patch.kind) {
    case "rewrite_file":
      return applyRewriteFile(content, patch.content || patch.replace || "");

    case "replace_text":
    case "replace_block": {
      const search = patch.search || patch.before || patch.anchor;
      const replace = patch.replace || patch.after || patch.content || "";
      return applyReplaceText(content, search, replace);
    }

    case "insert_before":
      return applyInsertBefore(content, patch.anchor || patch.search, patch.content || patch.replace || patch.after || "");

    case "insert_after":
      return applyInsertAfter(content, patch.anchor || patch.search, patch.content || patch.replace || patch.after || "");

    case "delete_text":
      return applyDeleteText(content, patch.search || patch.anchor || patch.before);

    default:
      return { ok: false, content, error: `unknown patch kind: ${patch.kind}` };
  }
}

async function saveUndoSnapshot(workspacePath, sessionId, requestId, plan) {
  try {
    const normSession = normalizeId("sess", sessionId);
    const normRequest = normalizeId("req", requestId);
    const snapshotDir = path.join(HISTORY_ROOT, normSession, normRequest);

    await fs.mkdir(snapshotDir, { recursive: true });

    // Retries and multi-task runs call executeChangesNode several times with the SAME
    // requestId. The first call snapshots the true pre-request state; a later call must
    // NOT re-snapshot a file it already captured — by then the file holds attempt-1's
    // modifications, and "restoring" that makes the Undo button appear to do nothing.
    // Merge: keep existing entries untouched, snapshot only files not yet captured.
    const metaPath = path.join(snapshotDir, "meta.json");
    let existingFiles = [];
    try {
      const existingMeta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
      if (Array.isArray(existingMeta?.files)) existingFiles = existingMeta.files;
    } catch { /* no prior snapshot for this request — fresh capture */ }
    const alreadySnapshotted = new Set(existingFiles.map((f) => f.relativePath));

    const writableSteps = plan.filter((p) =>
      (p.action === "edit" || p.action === "create" || p.action === "delete" || p.action === "rewrite_file") &&
      p.path && !alreadySnapshotted.has(p.path)
    );

    if (writableSteps.length === 0 && existingFiles.length > 0) {
      console.log(`[Execute] Undo snapshot already covers all files for ${normRequest} — keeping original pre-request state`);
      return;
    }

    const metaFiles = [...existingFiles];

    for (const step of writableSteps) {
      let absPath = safeResolvePath(workspacePath, step.path);
      let previousContent = null;
      let existedBefore = true;

      try {
        previousContent = await fs.readFile(absPath, "utf-8");
      } catch {
        const resolved = await findFileByPartialPath(PROJECT_ROOT, step.path);
        if (resolved) {
          absPath = resolved;
          try {
            previousContent = await fs.readFile(absPath, "utf-8");
          } catch {
            existedBefore = false;
          }
        } else {
          existedBefore = false;
        }
      }

      let snapshotPath = null;
      if (existedBefore && previousContent !== null) {
        const safeName = step.path.replace(/[/\\]/g, "__") + ".snap";
        const snapFile = path.join(snapshotDir, safeName);
        await fs.writeFile(snapFile, previousContent, "utf-8");
        snapshotPath = snapFile;
      }

      metaFiles.push({
        relativePath: step.path,
        fullPath: absPath,
        existedBefore,
        snapshotPath,
      });
    }

    await fs.writeFile(
      metaPath,
      JSON.stringify(
        {
          sessionId: normSession,
          requestId: normRequest,
          workspacePath: workspacePath || null,
          createdAt: new Date().toISOString(),
          files: metaFiles,
        },
        null,
        2
      ),
      "utf-8"
    );

    console.log(`[Execute] Undo snapshot saved: ${snapshotDir}`);
  } catch (err) {
    console.warn("[Execute] Could not save undo snapshot:", err.message);
  }
}

const ACTION_ICON = { edit: "✏️", create: "➕", delete: "🗑️", read_only: "👁️" };

export async function executeChangesNode(state) {
  const { plan, workspacePath, emit, retryCount, sessionId, requestId, permissionMode, approvalPromise, modelRoute } = state;
  const root = workspacePath || PROJECT_ROOT;

  if (!Array.isArray(plan) || plan.length === 0) {
    emit?.({ type: "progress", stage: "execute_skip", message: "⏩ No changes to execute." });
    return { executionResults: [] };
  }

  const actionable = plan.filter((p) => p.action !== "read_only" && p.path);
  if (actionable.length === 0) {
    const descriptions = plan.map(p => p.description || p.path || "no description").join("; ");
    console.warn(`[Execute] ⚠️ Plan has no actionable steps (all read_only). Descriptions: ${descriptions.slice(0, 300)}`);
    emit?.({ type: "progress", stage: "execute_skip", message: "ℹ️ Read-only — no file changes." });
    return { executionResults: [] };
  }

  // In "ask" permission mode: emit a plan_preview event so the UI can show an
  // Approve/Cancel prompt, then pause until the user confirms (or rejects).
  if (permissionMode === "ask" && approvalPromise && retryCount === 0) {
    emit?.({
      type: "plan_preview",
      steps: actionable.map((s) => ({
        action:      s.action,
        path:        s.path,
        description: s.description || "",
      })),
    });
    try {
      await approvalPromise;
      emit?.({ type: "progress", stage: "executing", message: "✅ Plan approved — applying changes…" });
    } catch {
      emit?.({ type: "progress", stage: "cancelled", message: "🚫 Plan cancelled by user." });
      emit?.({ type: "content", content: "Plan was cancelled. No files were changed." });
      return { executionResults: [] };
    }
  }

  if (sessionId && requestId) {
    await saveUndoSnapshot(root, sessionId, requestId, plan);
  }

  emit?.({
    type: "progress",
    stage: "executing",
    message: retryCount > 0 ? `🔄 Retry ${retryCount}…` : `⚙️ Applying ${actionable.length} change(s)…`,
  });

  const executionResults = [];

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    const icon = ACTION_ICON[step.action] || "📝";

    if (step.action === "read_only") {
      emit?.({
        type: "progress",
        stage: "step",
        message: `${icon} [${i + 1}/${plan.length}] ${step.description}`,
      });
      executionResults.push({
        action: step.action,
        path: step.path,
        success: true,
        note: step.description,
      });
      continue;
    }

    if (!step.path) {
      executionResults.push({ action: step.action, path: "", success: false, error: "No path" });
      continue;
    }

    let absPath;
    try {
      absPath = safeResolvePath(root, step.path);
    } catch (err) {
      executionResults.push({
        action: step.action,
        path: step.path,
        success: false,
        error: err.message,
      });
      emit?.({ type: "file_change", action: step.action, path: step.path, success: false, error: err.message });
      continue;
    }

    emit?.({
      type: "progress",
      stage: "step",
      message: `${icon} [${i + 1}/${plan.length}] ${step.action.toUpperCase()} ${step.path}`,
    });

    let result = { success: false, error: "unknown" };
    let diffPayload = null;
    let failedPatchDetails = [];

    try {
      if (step.action === "create") {
        // LLM may put file content in patches[0].content (rewrite_file) instead of step.content
        let createContent = String(step.content || "");
        if (!createContent) {
          const rwPatch = (step.patches || []).find(p => p.kind === "rewrite_file" && p.content);
          if (rwPatch) createContent = String(rwPatch.content || "");
        }
        let createSyntaxErr = validateSyntax(createContent, absPath);
        if (createSyntaxErr) {
          const repaired = await attemptSyntaxRepair(createContent, createSyntaxErr, step.path, absPath, modelRoute, emit);
          if (repaired) {
            createContent = repaired;
            createSyntaxErr = null;
          }
        }
        if (createSyntaxErr) {
          console.warn(`[Execute] 🚫 Syntax error in created file ${step.path} — write aborted: ${createSyntaxErr}`);
          result = { success: false, error: `Syntax error: ${createSyntaxErr}` };
        } else {
          await writeFileAtomic(absPath, createContent);
          result = { success: true };
          diffPayload = {
            action: "create", path: step.path, language: langFromPath(step.path),
            hunks: [{ kind: "create", after: createContent.slice(0, REWRITE_HUNK_MAX) }],
          };
        }
      } else if (step.action === "delete") {
        const deletedContent = (await readFileSafe(absPath)) || "";
        try {
          await fs.unlink(absPath);
          result = { success: true };
          diffPayload = {
            action: "delete", path: step.path, language: langFromPath(step.path),
            hunks: [{ kind: "delete", before: deletedContent.slice(0, REWRITE_HUNK_MAX) }],
          };
        } catch (e) {
          result = { success: false, error: e.message };
        }
      } else if (step.action === "edit") {
        let original = await readFileSafe(absPath);

        if (original === null) {
          const resolved = await findFileByPartialPath(PROJECT_ROOT, step.path);
          if (resolved) {
            absPath = resolved;
            original = await readFileSafe(absPath);
            console.log(`[Execute] Resolved "${step.path}" → "${path.relative(root, absPath)}"`);
          }
        }

        if (original === null) {
          result = { success: false, error: `File not found: ${step.path}` };
        } else {
          const patches = extractPatches(step);

          if (!patches.length) {
            result = { success: false, error: "No patches provided" };
          } else {
            let working = original;
            const patchResults = [];
            // Track failed patch anchors — verify.mjs feeds these back to the planner on retry
            // so the model sees exactly what search text didn't match (Claude Code approach).

            for (let p = 0; p < patches.length; p++) {
              const patch = patches[p];
              const applied = applyOnePatch(working, patch);

              patchResults.push(applied.ok);

              if (applied.ok) {
                working = applied.content;
              } else {
                console.warn(`[Execute] Patch ${p + 1}/${patches.length} on ${step.path}: ${applied.error}`);
                failedPatchDetails.push({
                  kind: patch.kind,
                  search: (patch.search || patch.anchor || patch.before || "").slice(0, 400),
                  error: applied.error,
                });
              }
            }

            const appliedCount = patchResults.filter(Boolean).length;

            if (appliedCount > 0 && working === original) {
              // Patches "applied" but produced identical content (search === replace,
              // or edits that cancel out). The file already satisfies the request —
              // report that honestly instead of a fake "Successfully applied" with a
              // diff whose before and after are the same bytes. No write, no diff.
              console.log(`[Execute] No-op edit on ${step.path} — content already matches the request`);
              result = {
                success: true,
                noop: true,
                note: "file already matched the requested state — no changes were needed",
              };
            } else if (appliedCount > 0) {
              let syntaxErr = validateSyntax(working, absPath);
              if (syntaxErr) {
                // Fix forward before failing: we hold the broken content AND the
                // exact error — one targeted repair beats a blind re-plan.
                const repaired = await attemptSyntaxRepair(working, syntaxErr, step.path, absPath, modelRoute, emit);
                if (repaired) {
                  working = repaired;
                  syntaxErr = null;
                }
              }
              if (syntaxErr) {
                console.warn(`[Execute] 🚫 Syntax error in ${step.path} after patching — write aborted: ${syntaxErr}`);
                result = { success: false, error: `Syntax error after patch: ${syntaxErr}` };
              } else {
                await writeFileAtomic(absPath, working);
                result = {
                  success: true,
                  note: `${appliedCount}/${patches.length} patch(es) applied`,
                  partial: appliedCount < patches.length,
                };
                diffPayload = {
                  action: "edit", path: step.path, language: langFromPath(step.path),
                  hunks: patches
                    .map((p, idx) => patchResults[idx] ? buildDiffHunk(p, original, working) : null)
                    .filter(Boolean),
                };
              }
            } else {
              result = {
                success: false,
                error: `0/${patches.length} patches matched — file unchanged`,
              };
            }
          }
        }
      } else if (step.action === "rewrite_file") {
        // Full-file rewrite — content comes from step.content or from the first patch
        let rewriteContent = String(step.content || "");
        if (!rewriteContent) {
          const rwPatch = (step.patches || []).find(p => p.content);
          if (rwPatch) rewriteContent = String(rwPatch.content || "");
        }
        if (!rewriteContent) {
          result = { success: false, error: "rewrite_file: no content provided" };
        } else {
          let syntaxErr = validateSyntax(rewriteContent, absPath);
          if (syntaxErr) {
            const repaired = await attemptSyntaxRepair(rewriteContent, syntaxErr, step.path, absPath, modelRoute, emit);
            if (repaired) {
              rewriteContent = repaired;
              syntaxErr = null;
            }
          }
          if (syntaxErr) {
            result = { success: false, error: `Syntax error: ${syntaxErr}` };
          } else {
            const original = (await readFileSafe(absPath)) || "";
            await writeFileAtomic(absPath, rewriteContent);
            result = { success: true };
            diffPayload = {
              action: "edit", path: step.path, language: langFromPath(step.path),
              hunks: [{ kind: "rewrite", before: original.slice(0, REWRITE_HUNK_MAX), after: rewriteContent.slice(0, REWRITE_HUNK_MAX) }],
            };
          }
        }
      } else {
        result = { success: false, error: `Unknown action: ${step.action}` };
      }
    } catch (err) {
      result = { success: false, error: err.message };
    }

    emit?.({
      type: "file_change",
      action: step.action,
      path: step.path,
      success: result.success,
      error: result.error || null,
    });

    if (diffPayload) {
      emit?.({ type: "file_diff", ...diffPayload });
    }

    executionResults.push({
      action: step.action,
      path: step.path,
      success: result.success,
      error: result.error || null,
      description: step.description,
      note: result.note,
      noop: result.noop || undefined,
      // failedPatches lets verify.mjs include the exact search anchors in retry context
      failedPatches: failedPatchDetails.length > 0 ? failedPatchDetails : undefined,
    });

    if (result.success) console.log(`[Execute] ✅ ${step.action} ${step.path}${result.note ? " — " + result.note : ""}`);
    else console.error(`[Execute] ❌ ${step.action} ${step.path}: ${result.error}`);
  }

  const ok = executionResults.filter((r) => r.success).length;
  const fail = executionResults.filter((r) => !r.success).length;

  emit?.({
    type: "progress",
    stage: "executed",
    message: `✅ ${ok} change(s) applied${fail ? ` — ⚠️ ${fail} failed` : ""}.`,
  });

  return {
    executionResults,
    retryCount: retryCount || 0,
    messages: [new AIMessage(`Execution: ${ok} succeeded, ${fail} failed.`)],
  };
}