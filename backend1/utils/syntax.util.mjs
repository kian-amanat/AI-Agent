/**
 * utils/syntax.util.mjs
 * Pre-write syntax + structural validation, extracted from the old
 * execute_changes node so the unified agent loop can reuse it.
 *
 * validateSyntax(content, absPath) → null when clean, or a short error string.
 * Every check here exists because the un-checked version of it shipped a real
 * breakage at least once (see inline notes).
 */

import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const _require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

let _tsCache = undefined; // undefined = not tried; null = not found; else the module

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

/**
 * The first `React.<x>` that is a real runtime value reference, or null.
 *
 * A type annotation like `e: React.KeyboardEvent` parses as a QualifiedName
 * inside a type node and is erased at compile time; only a
 * PropertyAccessExpression whose target is the identifier `React` survives into
 * emitted JS and can throw ReferenceError. Type nodes are skipped wholesale,
 * which also covers `React.FC<Props>`, `satisfies`, and type-only generics.
 */
function findReactValueUse(ts, srcFile) {
  let found = null;
  const visit = (node) => {
    if (found) return;
    // Everything under a type node is erased — nothing there can run.
    if (ts.isTypeNode?.(node) || ts.isTypeReferenceNode(node) || ts.isTypeQueryNode(node)) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "React"
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(srcFile, visit);
  return found;
}

export function validateSyntax(content, absPath) {
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

  // CSS/SCSS: an edit that anchors mid-rule can slice a declaration in half,
  // leaving orphaned properties and stray closers. Brace-depth scan catches it.
  if (ext === ".css" || ext === ".scss") {
    let depth = 0;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/\/\*[\s\S]*?\*\//g, "").replace(/"[^"]*"|'[^']*'/g, "");
      for (const ch of line) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth < 0) return `L${i + 1}: unexpected "}" — closing brace without a matching open (edit likely landed mid-rule)`;
        }
      }
    }
    if (depth !== 0) return `unbalanced braces: ${depth} unclosed "{" at end of file (edit likely landed mid-rule)`;
    return null;
  }

  // .mjs/.cjs are plain JavaScript and .mts/.cts plain TypeScript — the module
  // flavour in the extension changes nothing the parser cares about. Omitting
  // them meant validateSyntax returned "clean" for every ESM source file, so
  // edit_file's and write_file's syntax gates silently no-opped on exactly the
  // files a Node project is mostly made of. A single edit that replaced a
  // construct's opening line while its new text re-closed the construct left
  // the original body orphaned, and the corrupted file reached disk with the
  // tool reporting success.
  if (![".tsx", ".jsx", ".ts", ".js", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) return null;
  const ts = loadTypeScript();
  if (!ts) return null;
  const scriptKind = ext === ".tsx" ? ts.ScriptKind.TSX
                   : ext === ".jsx" ? ts.ScriptKind.JSX
                   : (ext === ".ts" || ext === ".mts" || ext === ".cts") ? ts.ScriptKind.TS
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
    // fails the build.
    if (/^\s*["']use client["']/.test(content) && /export\s+const\s+metadata\b/.test(content)) {
      return `"use client" component exports "metadata" — disallowed in Next.js. Keep the file a Server Component or move the client logic (hooks, event handlers) into a separate client component file.`;
    }

    // Automatic JSX runtime has no React global: React.useRef without importing
    // React parses fine but throws ReferenceError at runtime.
    //
    // VALUE positions only. `e: React.KeyboardEvent`, `React.ReactNode`,
    // `React.FC` are type annotations — erased before the code ever runs, so
    // they cannot throw the ReferenceError this rule exists to prevent. A regex
    // over the raw text cannot tell the two apart, and treating them alike
    // rejected one of the most common React+TS idioms there is (a typed event
    // handler). Ask the AST instead: only a PropertyAccessExpression on the
    // identifier `React` is a real runtime reference.
    if (!/import\s+(?:\*\s+as\s+)?React\b|import\s+React\s*,/.test(content)) {
      const runtimeUse = findReactValueUse(ts, srcFile);
      if (runtimeUse) {
        const line = srcFile.getLineAndCharacterOfPosition(runtimeUse.getStart(srcFile)).line + 1;
        return `L${line}: uses React.<something> at runtime but never imports React — add \`import React from 'react'\` or import the hook directly (e.g. \`import { useRef } from 'react'\`).`;
      }
    }

    // Local/alias imports must resolve to real files (Module-not-found is a build break).
    const importErr = checkLocalImportsResolve(content, absPath);
    if (importErr) return importErr;

    const dupImport = checkDuplicateImports(ts, srcFile);
    if (dupImport) return dupImport;

    if (ext === ".tsx" || ext === ".jsx") {
      return checkJsxStructuralIssues(ts, srcFile);
    }

    return null;
  } catch { return null; }
}

// Resolve "./x", "../x", and "@/x" import specifiers against the filesystem the
// way the bundler will. "@/" maps to the file's sub-project root (nearest ancestor
// with a package.json). Bare package names are ignored.
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
      return `L${line}: import "${spec}" does not resolve to any existing file — create that module first (with write_file) or keep the code in this file instead of importing it.`;
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
        return `L${lc.line + 1}: duplicate import "${name}" (already imported at L${seen.get(name)}) — the edit likely added a new import block instead of extending the existing one`;
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

  // 2. Capitalized JSX tag used without being imported or declared in the file.
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

/**
 * Top-level exported names in a module, via the parser rather than a regex so
 * `export { a as b }`, `export default`, and multi-declarator statements are
 * all counted the way the module system counts them.
 *
 * Returns null when the file type isn't parseable here — the caller must treat
 * that as "cannot tell", never as "nothing is exported".
 */
export function exportedNames(content, absPath) {
  const ext = path.extname(absPath).toLowerCase();
  if (![".tsx", ".jsx", ".ts", ".js", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) return null;
  const ts = loadTypeScript();
  if (!ts) return null;
  const scriptKind = ext === ".tsx" ? ts.ScriptKind.TSX
                   : ext === ".jsx" ? ts.ScriptKind.JSX
                   : (ext === ".ts" || ext === ".mts" || ext === ".cts") ? ts.ScriptKind.TS
                   : ts.ScriptKind.JS;
  let src;
  try {
    src = ts.createSourceFile("exports" + ext, content, ts.ScriptTarget.ESNext, true, scriptKind);
  } catch { return null; }
  // A file that does not parse cannot be compared against — the syntax gate
  // owns that failure, and guessing at exports here would double-report it.
  if (Array.isArray(src.parseDiagnostics) && src.parseDiagnostics.length > 0) return null;

  const names = new Set();
  const hasExportMod = (n) =>
    n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  for (const stmt of src.statements) {
    if (ts.isExportAssignment(stmt)) { names.add("default"); continue; }
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) names.add(el.name.text);
      }
      continue;
    }
    if (!hasExportMod(stmt)) continue;
    // `export default function d() {}` exposes "default"; `d` stays local, so
    // counting it too would report a phantom export as deleted on any rewrite
    // that renamed it.
    if (stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
      names.add("default");
      continue;
    }
    if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name) {
      names.add(stmt.name.text);
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) names.add(d.name.text);
      }
    } else if (stmt.name?.text) {
      names.add(stmt.name.text);
    }
  }
  return [...names];
}

/**
 * Exports present before an overwrite and absent after it.
 *
 * Returns [] when either side cannot be parsed — "cannot tell" must never
 * escalate into a false accusation that code was dropped.
 */
export function removedExports(before, after, absPath) {
  const a = exportedNames(before, absPath);
  const b = exportedNames(after, absPath);
  if (!a || !b) return [];
  return a.filter((n) => !b.includes(n));
}

async function ensureParentDir(absPath) {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
}

export async function writeFileAtomic(absPath, content) {
  await ensureParentDir(absPath);
  const tmpPath = `${absPath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, absPath);
}
