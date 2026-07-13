/**
 * install_packages.mjs
 * Runs real package install commands based on what the user asks for.
 *
 * Supports:
 *  - npm / yarn / pnpm  (auto-detected per package)
 *  - shadcn  → npx shadcn@latest add <component> --yes
 *  - generic → <pm> install <packages...>
 *  - target directory detection (frontend / backend / root)
 */

import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { AIMessage } from "@langchain/core/messages";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");

// ─── Special packages that need custom install commands ──────────

const SPECIAL_PACKAGES = {
  shadcn: {
    match: /\bshadcn\b/i,
    buildCmd: (pkg, components) =>
      components.length > 0
        ? { cmd: "npx", args: ["shadcn@latest", "add", ...components, "--yes"] }
        : { cmd: "npx", args: ["shadcn@latest", "init", "--yes"] },
    targetHint: "frontend",
  },
  "shadcn-ui": {
    match: /\bshadcn[-/]ui\b/i,
    buildCmd: (pkg, components) =>
      components.length > 0
        ? { cmd: "npx", args: ["shadcn@latest", "add", ...components, "--yes"] }
        : { cmd: "npx", args: ["shadcn@latest", "init", "--yes"] },
    targetHint: "frontend",
  },
};

// ─── Helpers ─────────────────────────────────────────────────────

async function detectPackageManager(dir) {
  try {
    await fs.access(path.join(dir, "yarn.lock"));
    return "yarn";
  } catch {}
  try {
    await fs.access(path.join(dir, "pnpm-lock.yaml"));
    return "pnpm";
  } catch {}
  return "npm";
}

// Walk up from a file's directory to the nearest package.json owner — npm-style
// resolution. Used to target installs at the project the user is actually
// working in when they don't say ("install gsap" while editing the Next app
// must land in chatbot/my-chatbot-ui, not the workspace root).
async function findNearestPackageDir(startDir, stopAt) {
  let dir = startDir;
  const stop = path.resolve(stopAt);
  while (true) {
    try {
      await fs.access(path.join(dir, "package.json"));
      return dir;
    } catch { /* keep walking */ }
    if (path.resolve(dir) === stop) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function findPackageDir(root, hint) {
  // hint: "frontend" | "backend" | "root" | undefined
  if (!hint || hint === "root") return root;

  const frontendAliases = ["frontend", "chatbot", "ui", "next", "client"];
  const backendAliases  = ["backend", "backend1", "server", "api"];

  const isFrontend = frontendAliases.includes(hint.toLowerCase());
  const isBackend  = backendAliases.includes(hint.toLowerCase());

  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name.toLowerCase();

      if (isFrontend && (name.includes("chatbot") || name.includes("frontend") || name.includes("ui") || name.includes("client"))) {
        // Recurse one level for nested dirs like chatbot/my-chatbot-ui
        const inner = path.join(root, entry.name);
        try {
          const innerEntries = await fs.readdir(inner, { withFileTypes: true });
          for (const ie of innerEntries) {
            if (!ie.isDirectory()) continue;
            try {
              await fs.access(path.join(inner, ie.name, "package.json"));
              return path.join(inner, ie.name);
            } catch {}
          }
          await fs.access(path.join(inner, "package.json"));
          return inner;
        } catch {}
      }

      if (isBackend && (name.includes("backend") || name.includes("server") || name.includes("api"))) {
        try {
          await fs.access(path.join(root, entry.name, "package.json"));
          return path.join(root, entry.name);
        } catch {}
      }
    }
  } catch {}

  return root;
}

function runCommand(cmd, args, cwd, emit, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    emit?.({ type: "progress", stage: "install_running", message: `  ▶ ${cmd} ${args.join(" ")}` });

    const child = spawn(cmd, args, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => {
      const chunk = d.toString();
      stdout += chunk;
      // Stream progress lines to the UI
      const lines = chunk.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        emit?.({ type: "progress", stage: "install_output", message: `  ${line}` });
      }
    });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 4000);
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr, command: `${cmd} ${args.join(" ")}` });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: stderr + err.message, command: `${cmd} ${args.join(" ")}` });
    });
  });
}

// ─── Package + component extraction ──────────────────────────────

// Known shadcn component names
const SHADCN_COMPONENTS = new Set([
  "accordion","alert","alert-dialog","aspect-ratio","avatar","badge","breadcrumb",
  "button","calendar","card","carousel","chart","checkbox","collapsible","command",
  "context-menu","data-table","date-picker","dialog","drawer","dropdown-menu",
  "form","hover-card","input","input-otp","label","menubar","navigation-menu",
  "pagination","popover","progress","radio-group","resizable","scroll-area",
  "select","separator","sheet","sidebar","skeleton","slider","sonner","switch",
  "table","tabs","textarea","toast","toggle","toggle-group","tooltip",
]);

function extractInstallRequest(message) {
  const msg = String(message || "").toLowerCase().split(/conversation memory:/i)[0].trim();

  // Detect target: frontend / backend / root
  let targetHint = null;
  if (/\b(frontend|chatbot|ui|client|next\.?js)\b/i.test(msg)) targetHint = "frontend";
  else if (/\b(backend|backend1|server|api|node)\b/i.test(msg)) targetHint = "backend";

  // Check for shadcn first
  for (const [key, spec] of Object.entries(SPECIAL_PACKAGES)) {
    if (spec.match.test(msg)) {
      // Extract component names mentioned after "shadcn"
      const components = [];
      for (const comp of SHADCN_COMPONENTS) {
        if (msg.includes(comp)) components.push(comp);
      }
      // Also capture bare words after "add" that look like component names
      const addMatch = msg.match(/\b(?:add|install)\s+(?:shadcn[-/]?ui?)?\s*([\w\s,-]+)$/i);
      if (addMatch) {
        const extra = addMatch[1]
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 1 && s !== "shadcn" && s !== "ui" && s !== "and");
        for (const e of extra) {
          if (!components.includes(e)) components.push(e);
        }
      }
      return { special: key, spec, components, targetHint: targetHint || spec.targetHint };
    }
  }

  // Generic package extraction
  // Match patterns like: install X, add X, npm install X
  const packageMatch = msg.match(
    /(?:install|add|npm\s+install|yarn\s+add|pnpm\s+add)\s+((?:[@\w][\w\-./]*(?:@[\w.*-]+)?\s*)+)/i
  );
  if (!packageMatch) return null;

  // Stop at the first preposition/stop word so "add date-fns for logging" → ["date-fns"]
  const INSTALL_STOP_WORDS = new Set(["for", "to", "in", "from", "as", "so", "that", "the", "a", "an", "of", "on", "at", "by", "with", "and", "or", "then", "when", "while"]);
  const packages = [];
  for (const p of packageMatch[1].trim().split(/\s+/)) {
    if (INSTALL_STOP_WORDS.has(p.toLowerCase())) break;
    if (p && !["--save", "--dev", "-D", "-S", "package", "packages"].includes(p)) packages.push(p);
  }

  const isDevDep = /\b(--dev|-D|devDependency|dev dependency)\b/i.test(msg);

  if (packages.length === 0) return null;
  return { packages, isDevDep, targetHint };
}

// ─── Node ────────────────────────────────────────────────────────

export async function installPackagesNode(state) {
  const { workspacePath, userMessage, emit, rememberedTargetFile } = state;
  const root = workspacePath || PROJECT_ROOT;

  const request = extractInstallRequest(userMessage);

  if (!request) {
    const answer = "I couldn't identify which package to install. Try: \"install react-query in frontend\" or \"add shadcn button\".";
    emit?.({ type: "progress", stage: "install_error", message: `⚠️ ${answer}` });
    return {
      finalAnswer: answer,
      messages: [new AIMessage(answer)],
    };
  }

  // Resolve target directory. With no explicit hint, prefer the project that owns
  // the file the session is working on — a bare "install gsap" mid-frontend-work
  // once landed in the workspace root instead of the Next app.
  let targetDir = await findPackageDir(root, request.targetHint);
  if (!request.targetHint && rememberedTargetFile) {
    const ownedDir = await findNearestPackageDir(
      path.dirname(path.resolve(root, rememberedTargetFile)),
      root
    );
    if (ownedDir && ownedDir !== root) {
      console.log(`[Install] No target hint — using remembered file's project: ${path.relative(root, ownedDir)}`);
      targetDir = ownedDir;
    }
  }
  const relDir    = path.relative(root, targetDir) || ".";
  const pm        = await detectPackageManager(targetDir);

  emit?.({ type: "progress", stage: "install_start", message: `📦 Installing in \`${relDir}\` using ${pm}…` });

  let result;

  if (request.special) {
    // shadcn or other special handler
    const { cmd, args } = request.spec.buildCmd(request.special, request.components);
    emit?.({
      type: "progress",
      stage: "install_cmd",
      message: `🔧 Running: ${cmd} ${args.join(" ")} (in ${relDir})`,
    });
    result = await runCommand(cmd, args, targetDir, emit);
  } else {
    // Generic npm/yarn/pnpm install
    let installArgs;
    if (pm === "yarn") {
      installArgs = ["add", ...request.packages, ...(request.isDevDep ? ["--dev"] : [])];
    } else if (pm === "pnpm") {
      installArgs = ["add", ...request.packages, ...(request.isDevDep ? ["-D"] : [])];
    } else {
      installArgs = ["install", ...request.packages, ...(request.isDevDep ? ["--save-dev"] : [])];
    }

    emit?.({
      type: "progress",
      stage: "install_cmd",
      message: `🔧 Running: ${pm} ${installArgs.join(" ")} (in ${relDir})`,
    });
    result = await runCommand(pm, installArgs, targetDir, emit);
  }

  const label = request.special
    ? `shadcn ${request.components.length ? request.components.join(", ") : "(init)"}`
    : request.packages?.join(", ");

  if (result.ok) {
    const answer = `✅ Installed **${label}** in \`${relDir}\`.`;
    emit?.({ type: "progress", stage: "install_done", message: answer });
    console.log(`[Install] ✅ ${label} → ${relDir}`);
    return {
      finalAnswer: answer,
      messages: [new AIMessage(answer)],
    };
  } else {
    const errOutput = [result.stdout, result.stderr].filter(Boolean).join("\n").slice(-2000);
    const answer = `❌ Failed to install **${label}** in \`${relDir}\`.\n\n\`\`\`\n${errOutput}\n\`\`\``;
    emit?.({ type: "progress", stage: "install_fail", message: `❌ Install failed:\n${errOutput}` });
    console.error(`[Install] ❌ ${label}: exit ${result.code}`);
    return {
      finalAnswer: answer,
      messages: [new AIMessage(answer)],
    };
  }
}
