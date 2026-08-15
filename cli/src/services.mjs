/**
 * src/services.mjs — what each managed process actually is.
 *
 * Kodo has two servers, and they are genuinely different things:
 *
 *   api  — backend1's Fastify app. THE Local API: sessions, SSE streaming,
 *          settings, auth, workspace. The Next.js UI and the VS Code extension
 *          both already speak it. `kodo server` manages this.
 *
 *   ui   — what a browser loads. Preferably the real Next.js application in
 *          chatbot/my-chatbot-ui; the CLI's own single-file page when that has
 *          not been built. `kodo ui` manages this, and ensures `api` is up
 *          first, because a UI with nothing to talk to is not a working UI.
 *
 * Architecture:  Kodo Core → Local API (api) → Next.js UI (ui)
 *
 * Keeping them separate rather than merging into one process is not ceremony:
 * the API must keep running while the UI restarts (a Next.js restart would
 * otherwise kill in-flight agent runs), and the extension needs the API without
 * any UI at all.
 */

import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo layout relative to this package. KODO_CORE_PATH overrides for installs. */
function repoRoot() {
  if (process.env.KODO_REPO_ROOT) return process.env.KODO_REPO_ROOT;
  return path.resolve(__dirname, "..", "..");
}

export function backendDir() {
  return process.env.KODO_BACKEND_PATH || path.join(repoRoot(), "backend1");
}

/**
 * Where the web UI lives.
 *
 * Two layouts, because an installed Kodo and a source checkout are genuinely
 * different shapes:
 *
 *   INSTALLED  <root>/ui/server.js          Next.js standalone output
 *   SOURCE     chatbot/my-chatbot-ui/       the development project
 *
 * The installed layout is checked FIRST. Preferring the source tree would make
 * a release quietly depend on a repository the user does not have.
 */
export function webUiDir() {
  if (process.env.KODO_WEBUI_PATH) return process.env.KODO_WEBUI_PATH;

  // Two bundled shapes, and the check must recognise BOTH:
  //   npm package      <root>/ui/.next/BUILD_ID   (ordinary build + declared next)
  //   release tarball  <root>/ui/server.js        (Next standalone output)
  //
  // Detecting only server.js meant the npm package fell through to the SOURCE
  // path, `chatbot/my-chatbot-ui`, which does not exist in an installed
  // package — so `kodo ui start` quietly served the built-in fallback page
  // instead of the real product, and reported success while doing it.
  const bundled = path.join(repoRoot(), "ui");
  if (fs.existsSync(path.join(bundled, "server.js"))
      || fs.existsSync(path.join(bundled, ".next", "BUILD_ID"))) {
    return bundled;
  }
  return path.join(repoRoot(), "chatbot", "my-chatbot-ui");
}

/**
 * Is Kodo running from an INSTALLED npm package, or from a source checkout?
 *
 * The two need opposite advice when a dependency is missing, and giving the
 * wrong one wastes real time. In a checkout, `npm --prefix backend1 install` is
 * the correct developer fix. In an installed package it is actively harmful
 * advice: dependencies live at the PACKAGE root, `backend1/package.json` is
 * vendored, and running npm there creates a nested tree that shadows the real
 * one. A missing dependency in an installed package is not a state the user is
 * supposed to repair by hand — it means the package is incomplete, and the only
 * correct answer is to reinstall it.
 *
 * The published manifest is named "kodo-agent"; every manifest in the
 * repository is private and named something else, which is enforced by
 * architectureFreeze. So the name is a reliable discriminator.
 */
export function isPackagedInstall() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot(), "package.json"), "utf-8"));
    return manifest.name === "kodo-agent";
  } catch {
    return false;
  }
}

/**
 * What to tell the user when a runtime dependency will not resolve.
 *
 * Kodo VALIDATES dependencies; it never installs them. Repairing its own
 * installation at runtime would mean an agent running `npm install` on the
 * user's machine as a side effect of an unrelated command — a supply-chain
 * action taken without consent, from a process the user asked to do something
 * else entirely.
 */
function dependencyFix(dir) {
  if (!isPackagedInstall()) return `npm --prefix ${dir} install`;
  const pkg = process.env.KODO_NPM_NAME || "kodo-agent";
  return `the installed ${pkg} package is incomplete — reinstall it: npm install -g ${pkg}`;
}

/** Is this a bundled (standalone) UI rather than a source checkout? */
export function isStandaloneUi(dir) {
  return fs.existsSync(path.join(dir, "server.js"))
    && !fs.existsSync(path.join(dir, "next.config.ts"));
}

/**
 * Is the Next.js UI usable? It needs both its dependencies and a production
 * build. Reporting precisely which is missing matters — "run npm install" and
 * "run npm run build" are different fixes, and guessing wrong wastes minutes.
 */
export function inspectWebUi() {
  const dir = webUiDir();

  // Bundled standalone: everything it needs is already there. Nothing to
  // install, nothing to build — that is the whole point of shipping it.
  if (isStandaloneUi(dir)) return { available: true, dir, standalone: true };

  if (!fs.existsSync(path.join(dir, "package.json"))) {
    return { available: false, dir, reason: "the Next.js UI is not part of this installation" };
  }
  if (!canResolve("next", dir)) {
    return { available: false, dir, reason: "Next.js cannot be resolved", fix: dependencyFix(dir) };
  }
  // BUILD_ID alone is NOT enough: `next dev` writes one too, and `next start`
  // against a dev .next crashes on a missing prerender-manifest.json — after
  // reporting "Ready", which makes it look like a Kodo bug rather than a
  // missing build. Check for an artifact only a production build produces.
  const productionArtifacts = ["BUILD_ID", "prerender-manifest.json"];
  const missing = productionArtifacts.filter((f) => !fs.existsSync(path.join(dir, ".next", f)));
  if (missing.length) {
    return {
      available: false,
      dir,
      reason: fs.existsSync(path.join(dir, ".next"))
        ? "its build is a development build, not a production one"
        : "it has not been built",
      fix: `npm --prefix ${dir} run build`,
    };
  }
  return { available: true, dir };
}

/**
 * Can a dependency be RESOLVED from `fromDir`?
 *
 * Checking for a `node_modules` directory next to the code was wrong the moment
 * Kodo shipped as an npm package: npm installs dependencies at the PACKAGE
 * root, so `backend1/node_modules` does not exist and never will. `kodo ui
 * start` then refused with "its dependencies are not installed" on a perfectly
 * good install, and told the user to run npm inside node_modules.
 *
 * Resolution is the question that actually matters, and it answers it correctly
 * in every layout: a checkout, a hoisted npm install, a pnpm store, a workspace.
 */
function canResolve(specifier, fromDir) {
  try {
    createRequire(path.join(fromDir, "package.json")).resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

export function inspectBackend() {
  const dir = backendDir();
  if (!fs.existsSync(path.join(dir, "server.mjs"))) {
    return { available: false, dir, reason: "backend1/server.mjs was not found" };
  }
  if (!canResolve("fastify", dir)) {
    return {
      available: false,
      dir,
      reason: "its dependencies cannot be resolved",
      fix: dependencyFix(dir),
    };
  }
  return { available: true, dir };
}

/**
 * Descriptor for a managed process.
 *
 * `healthUrl` is how the lifecycle manager decides a service is genuinely up
 * rather than merely spawned — printing a URL that 500s is worse than an error.
 */
export function apiService({ host, port, workspace }) {
  const dir = backendDir();
  return {
    name: "server",
    label: "Kodo API",
    cwd: dir,
    command: process.execPath,
    args: [path.join(dir, "server.mjs")],
    env: {
      KODO_HOST: host,
      PORT: String(port),
      KODO_PORT: String(port),
      // Deliberately NOT set. The API allows any loopback origin by default
      // (utils/cors.util.mjs), which is what lets it accept whichever port the
      // UI ends up on. Pinning it here would require knowing the UI's port
      // before the UI exists, and setting "*" would open a credentialed API to
      // every page the user has open.
      ...(process.env.KODO_ALLOWED_ORIGIN ? { KODO_ALLOWED_ORIGIN: process.env.KODO_ALLOWED_ORIGIN } : {}),
      WORKSPACE_PATH: workspace,
    },
    healthPath: "/health",
  };
}

/** Absolute path to Next.js's CLI entry point, wherever npm put it. */
function resolveNextBin(fromDir) {
  const require = createRequire(path.join(fromDir, "package.json"));
  // next/package.json is resolvable even though `next` itself has export maps
  // that hide the bin path.
  const pkgJson = require.resolve("next/package.json");
  return path.join(path.dirname(pkgJson), "dist", "bin", "next");
}

export function nextUiService({ host, port, apiOrigin }) {
  const dir = webUiDir();
  const standalone = isStandaloneUi(dir);

  // Standalone ships its own server.js and reads HOSTNAME/PORT from the
  // environment; a source checkout is driven through the `next` CLI. Same UI,
  // different entry point.
  // Resolve the `next` binary rather than assuming it sits in a node_modules
  // directory beside the UI — under npm it is hoisted to the package root.
  const nextBin = standalone ? null : resolveNextBin(dir);

  const args = standalone
    ? [path.join(dir, "server.js")]
    : [nextBin, "start", "--hostname", host, "--port", String(port)];

  return {
    name: "ui",
    label: standalone ? "Kodo UI (Next.js, bundled)" : "Kodo UI (Next.js)",
    cwd: dir,
    command: process.execPath,
    args,
    env: {
      NODE_ENV: "production",
      // standalone's server.js takes its bind from the environment.
      HOSTNAME: host,
      PORT: String(port),
      // Read by app/layout.tsx and injected into the page, so one prebuilt UI
      // works against whatever port the API actually got.
      KODO_API_ORIGIN: apiOrigin,
      NEXT_PUBLIC_KODO_API_ORIGIN: apiOrigin,
    },
    healthPath: "/",
  };
}
