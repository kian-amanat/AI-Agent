#!/usr/bin/env node
/**
 * scripts/build-npm-package.mjs — assemble the publishable npm package.
 *
 * `npm install -g kodo-agent` is the primary way people get Kodo, so this is
 * the primary build. It stages a clean tree in dist-npm/ and leaves it ready
 * for `npm pack` / `npm publish`.
 *
 * ── Why a staging directory rather than publishing the repo root ────────────
 *
 * The repository is a monorepo: backend1/, chatbot/my-chatbot-ui/ and cli/ are
 * separate npm projects with their own manifests, plus tests, benchmarks and
 * ~1.5 GB of development dependencies. Publishing from the root would mean
 * either shipping all of that or maintaining an `.npmignore` that has to be
 * right forever. Staging inverts the default: nothing ships unless it is named
 * here.
 *
 * ── Why dependencies are DECLARED, not bundled ──────────────────────────────
 *
 * The standalone release tarballs bundle node_modules, which is why they are
 * per-platform — better-sqlite3 is native and compiled for one platform and
 * Node ABI. An npm package does not have that problem and must not inherit it:
 * npm resolves dependencies on the user's machine, so the same published
 * package installs correctly on macOS, Linux and Windows, on any supported
 * Node. Bundling here would have thrown that away.
 *
 * ── Package layout ─────────────────────────────────────────────────────────
 *
 *   <pkg>/cli/bin/kodo.mjs     the `kodo` executable
 *   <pkg>/cli/src/             CLI
 *   <pkg>/backend1/            Kodo Core, agent, services, Local API
 *   <pkg>/ui/                  production Next.js build
 *
 * This mirrors the repository layout on purpose: cli/src/services.mjs resolves
 * siblings from its own location (`__dirname/../..`), so the same resolution
 * works in a checkout and in node_modules/kodo-agent — no install-time
 * rewriting, and no "works in dev, breaks when installed".
 */

import { createRequire } from "module";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const OUT = path.join(REPO, "dist-npm");

const cliPkg = require(path.join(REPO, "cli", "package.json"));
const backendPkg = require(path.join(REPO, "backend1", "package.json"));
const uiPkg = require(path.join(REPO, "chatbot", "my-chatbot-ui", "package.json"));

/**
 * `kodo` on npm is an unrelated 2013 MVC framework and `kodo-cli` is a status
 * page tool, so neither is available. The BINARY is still `kodo` — that is what
 * users type, and it is what the docs promise.
 */
const PACKAGE_NAME = process.env.KODO_NPM_NAME || "kodo-agent";
const VERSION = process.env.KODO_VERSION || cliPkg.version;

/** [from, to] relative to REPO and OUT. Explicit — nothing ships by accident. */
const PAYLOAD = [
  ["cli/bin", "cli/bin"],
  ["cli/src", "cli/src"],
  ["backend1/core", "backend1/core"],
  ["backend1/agents", "backend1/agents"],
  ["backend1/services", "backend1/services"],
  ["backend1/utils", "backend1/utils"],
  ["backend1/config", "backend1/config"],
  ["backend1/constants", "backend1/constants"],
  ["backend1/routes", "backend1/routes"],
  ["backend1/db.mjs", "backend1/db.mjs"],
  ["backend1/server.mjs", "backend1/server.mjs"],
  ["backend1/package.json", "backend1/package.json"],
  // The production UI. `.next` + public is what `next start` needs; `next`
  // itself is a declared dependency, so npm provides it per platform.
  ["chatbot/my-chatbot-ui/.next", "ui/.next"],
  ["chatbot/my-chatbot-ui/public", "ui/public"],
  // next.config is GENERATED, not copied — see writeUiConfig().

  ["README.md", "README.md"],
  ["LICENSE", "LICENSE"],
  ["docs", "docs"],
];

/**
 * Never shipped, wherever it appears. A published package is public forever —
 * an accidental `.env` cannot be recalled, only rotated.
 */
const FORBIDDEN = [
  /(^|\/)\.env($|\.)/,
  /\.db($|-wal$|-shm$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.kodo(\/|$)/,
  /(^|\/)uploads(\/|$)/,
  /(^|\/)tests?(\/|$)/,
  /(^|\/)bench(-report|-runs)?(\/|$)/,
  // `.next` holds far more than the production server needs. `next dev` leaves
  // 681 MB of dev-server artifacts in `.next/dev` alone — shipping it would
  // have made the package 733 MB, almost all of it unreachable at runtime.
  // `next start` needs BUILD_ID, server/, static/ and the manifests; nothing
  // else here is used.
  /(^|\/)\.next\/dev(\/|$)/,
  /(^|\/)\.next\/cache(\/|$)/,
  /(^|\/)\.next\/types(\/|$)/,
  /(^|\/)\.next\/trace(\/|$)/,
  /(^|\/)\.next\/diagnostics(\/|$)/,
  // The standalone layout is for the tarball release, which bundles its own
  // node_modules. npm strips nested node_modules from packs, so this package
  // uses the ordinary build plus declared `next`/`react` dependencies instead.
  /(^|\/)\.next\/standalone(\/|$)/,
  /\.test\.mjs$/,
  /\.tsbuildinfo$/,
];

const forbidden = (rel) => FORBIDDEN.some((re) => re.test(rel));

function copyPayload() {
  for (const [from, to] of PAYLOAD) {
    const src = path.join(REPO, from);
    if (!fs.existsSync(src)) {
      console.warn(`  ! skipping missing ${from}`);
      continue;
    }
    const dest = path.join(OUT, to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, {
      recursive: true,
      filter: (s) => !forbidden(path.relative(REPO, s).replace(/\\/g, "/")),
    });
  }
}

/**
 * The published manifest.
 *
 * Dependencies are backend1's production set plus the three the UI needs at
 * RUNTIME. The UI's build-time dependencies (tailwind, eslint, typescript, the
 * component libraries) are deliberately absent: `next start` serves an already
 * compiled `.next`, so shipping them would add hundreds of megabytes to every
 * install for no runtime benefit.
 */
function writeManifest() {
  const manifest = {
    name: PACKAGE_NAME,
    version: VERSION,
    description: "Kodo — AI coding agent for your terminal, with a local web UI and container sandboxing.",
    license: cliPkg.license || "MIT",
    author: cliPkg.author || undefined,
    homepage: "https://github.com/kodo-agent/kodo#readme",
    repository: { type: "git", url: "git+https://github.com/kodo-agent/kodo.git" },
    bugs: { url: "https://github.com/kodo-agent/kodo/issues" },
    keywords: [
      "ai", "agent", "coding-agent", "cli", "llm", "openai",
      "developer-tools", "sandbox", "docker", "langgraph",
    ],
    type: "module",
    bin: { kodo: "cli/bin/kodo.mjs" },
    // Node 20.12 is the floor: process.loadEnvFile and the fetch/AbortSignal
    // behaviour the lifecycle manager relies on both land there.
    engines: { node: ">=20.12.0" },
    files: ["cli", "backend1", "ui", "docs", "README.md", "LICENSE"],
    dependencies: {
      ...backendPkg.dependencies,
      next: uiPkg.dependencies.next,
      react: uiPkg.dependencies.react,
      "react-dom": uiPkg.dependencies["react-dom"],
    },
    // No install/postinstall hooks. `npm install` installs Kodo and does
    // nothing else: it must not build an application, start a server, or touch
    // a user's projects. See docs/installation.md.
    scripts: {},
    // A PRERELEASE must not become the `latest` dist-tag. npm assigns `latest`
    // by default even for `-rc` versions, so `npm install -g kodo-agent` would
    // hand every new user a release candidate. Prereleases go to `next`;
    // `latest` is claimed deliberately, by publishing a stable version once the
    // platform matrix has actually been verified.
    publishConfig: {
      access: "public",
      tag: /-/.test(VERSION) ? "next" : "latest",
    },
  };

  fs.writeFileSync(path.join(OUT, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * A minimal manifest for the UI directory.
 *
 * `next start` treats its working directory as a project and expects a
 * package.json there; without one, Kodo's own UI check concluded the UI "is not
 * part of this installation" and silently served the built-in fallback page
 * instead of the real product. It carries no dependencies — the package root
 * declares next/react/react-dom, and Node resolves upward.
 */
function writeUiManifest() {
  const manifest = {
    name: "kodo-ui",
    version: VERSION,
    private: true,
    // The UI build is CommonJS-compatible Next output; leaving "type" unset
    // keeps Next's own resolution behaviour, which is what it was built with.
    scripts: { start: "next start" },
  };
  fs.writeFileSync(path.join(OUT, "ui", "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * The UI's production Next config — generated, not copied from the source tree.
 *
 * The source config sets `output: "standalone"`, which is correct for the
 * RELEASE TARBALL: that artifact ships `.next/standalone/server.js` plus the
 * traced node_modules, and runs `node server.js`.
 *
 * This package is deliberately the other shape. It excludes `.next/standalone`
 * (npm strips nested node_modules from packs anyway) and instead declares
 * `next`/`react`/`react-dom` so npm resolves them per platform — see the header.
 * It is started with `next start`.
 *
 * Copying the source config verbatim shipped a config describing a run mode
 * this package does not use, and Next said so on every start:
 *
 *   "next start" does not work with "output: standalone" configuration.
 *   Use "node .next/standalone/server.js" instead.
 *
 * The warning was accurate — the config was wrong for this artifact. So the
 * fix is to ship a config that matches how the package is actually run, rather
 * than to silence the message.
 *
 * Emitted as .mjs, not .ts: a TypeScript config would need Next to compile it
 * at startup, and this package does not ship a TypeScript toolchain.
 *
 * Only production-relevant settings carry over. `turbopack.root` is a dev-server
 * concern and there is no dev server here.
 */
function writeUiConfig() {
  const uiConfig = `// Generated by scripts/build-npm-package.mjs — do not edit.
//
// The published package runs the UI with \`next start\` against an ordinary
// production build. It deliberately does NOT use \`output: "standalone"\`; that
// is the release-tarball shape, and declaring it here would make Next warn on
// every start that \`next start\` is the wrong entry point for it.
const nextConfig = {
  images: {
    qualities: [75, 100],
  },
};

export default nextConfig;
`;
  fs.writeFileSync(path.join(OUT, "ui", "next.config.mjs"), uiConfig);
}

/** Fail the build rather than publish a secret or a broken package. */
function audit(manifest) {
  const problems = [];
  const required = [
    "cli/bin/kodo.mjs",
    "cli/src/main.mjs",
    "backend1/core/index.mjs",
    "backend1/server.mjs",
    "ui/.next/BUILD_ID",
    "ui/package.json",
    "ui/next.config.mjs",
  ];
  for (const rel of required) {
    if (!fs.existsSync(path.join(OUT, rel))) problems.push(`missing required file: ${rel}`);
  }

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(OUT, full).replace(/\\/g, "/");
      if (entry.isDirectory()) { walk(full); continue; }
      if (forbidden(rel)) { problems.push(`must not be published: ${rel}`); continue; }
      if (/\.(mjs|js|json|md|ts|tsx)$/.test(entry.name) && !rel.startsWith("ui/.next/")) {
        const text = fs.readFileSync(full, "utf-8");
        if (/\bsk-[A-Za-z0-9_-]{20,}/.test(text) && !/sk-(test|not-a-real|proj-abc|ant-)/.test(text)) {
          problems.push(`${rel} contains an API-key-shaped string`);
        }
      }
    }
  };
  walk(OUT);

  // The executable must be executable, or npm's shim will not run it.
  const bin = path.join(OUT, "cli", "bin", "kodo.mjs");
  if (fs.existsSync(bin)) {
    const first = fs.readFileSync(bin, "utf-8").split("\n")[0];
    if (!first.startsWith("#!")) problems.push("cli/bin/kodo.mjs has no shebang");
    fs.chmodSync(bin, 0o755);
  }

  if (manifest.scripts && Object.keys(manifest.scripts).length) {
    problems.push("the published package must declare no lifecycle scripts");
  }

  if (problems.length) {
    throw new Error(`Refusing to build the npm package:\n  ${problems.join("\n  ")}`);
  }
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

function main() {
  console.log(`\nBuilding the ${PACKAGE_NAME} npm package (v${VERSION})\n`);

  if (!fs.existsSync(path.join(REPO, "chatbot", "my-chatbot-ui", ".next", "BUILD_ID"))) {
    throw new Error("The UI has not been built. Run `npm run ui:build` first.");
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  copyPayload();
  console.log("  ✓ staged payload");

  writeUiManifest();
  writeUiConfig();
  console.log("  ✓ ui/package.json + next.config.mjs (next start, not standalone)");

  const manifest = writeManifest();
  console.log(`  ✓ package.json — bin "kodo", ${Object.keys(manifest.dependencies).length} dependencies, no lifecycle scripts`);

  audit(manifest);
  console.log("  ✓ audited (no secrets, no node_modules, no tests, entry points present)");

  console.log(`  ✓ staged size: ${(dirSize(OUT) / 1e6).toFixed(1)} MB\n`);
  console.log(`  Pack it:      npm pack --pack-destination . ${path.relative(REPO, OUT)}`);
  console.log(`  Install it:   npm install -g ./${PACKAGE_NAME}-${VERSION}.tgz`);
  console.log(`  Publish it:   npm publish ${path.relative(REPO, OUT)}\n`);
}

main();
