#!/usr/bin/env node
/**
 * scripts/build-release.mjs — produce release artifacts.
 *
 * Kodo is a Node application, so a "release" is a tarball containing the CLI,
 * Kodo Core and its production dependencies, plus a SHA256SUMS file the
 * installer verifies before putting anything on your PATH.
 *
 * This exists so the release path in install.sh is TESTABLE rather than
 * theoretical. `scripts/test-release.sh` builds artifacts with this, serves
 * them over a local HTTP server, and runs the real installer against them —
 * including a deliberately corrupted artifact, to prove the checksum check
 * actually refuses.
 *
 * There is no public release host. This produces artifacts locally; publishing
 * them is a separate decision that has not been made.
 *
 * Usage:
 *   node scripts/build-release.mjs [--out DIR] [--version X.Y.Z] [--platform os-arch]
 */

import { createRequire } from "module";
import { execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const VERSION = arg("version", require(path.join(REPO, "cli", "package.json")).version);
const OUT = path.resolve(arg("out", path.join(REPO, "dist")));

/**
 * Node runs everywhere, so the payload is identical across platforms. The
 * per-platform names exist because the installer asks for one by platform —
 * keeping that shape now means publishing platform-specific builds later (a
 * bundled Node runtime, say) does not change the installer or its URLs.
 */
const PLATFORMS = arg("platform", currentPlatform()).split(",");

/**
 * Default to THIS machine's platform only.
 *
 * Naming four targets while producing four identical copies of this machine's
 * build was a lie the filenames told: the artifacts bundle a native module, so
 * a "linux-x64" tarball built on macOS arm64 would install and then fail to
 * load better-sqlite3. Each target has to be built on that platform — see
 * .github/workflows/release.yml — and this default stops a local build from
 * silently mislabelling itself.
 */
function currentPlatform() {
  const os = process.platform === "win32" ? "win32" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
  return `${os}-${arch}`;
}

// What actually ships. Deliberately explicit rather than "everything except
// node_modules": a release should never accidentally carry .env, memory.db,
// uploads, or a developer's .kodo directory.
const PAYLOAD = [
  ["cli/bin", "kodo/cli/bin"],
  ["cli/src", "kodo/cli/src"],
  ["cli/package.json", "kodo/cli/package.json"],
  ["backend1/core", "kodo/backend1/core"],
  ["backend1/agents", "kodo/backend1/agents"],
  ["backend1/services", "kodo/backend1/services"],
  ["backend1/utils", "kodo/backend1/utils"],
  ["backend1/config", "kodo/backend1/config"],
  ["backend1/constants", "kodo/backend1/constants"],
  ["backend1/routes", "kodo/backend1/routes"],
  ["backend1/db.mjs", "kodo/backend1/db.mjs"],
  ["backend1/server.mjs", "kodo/backend1/server.mjs"],
  ["backend1/package.json", "kodo/backend1/package.json"],
  ["backend1/package-lock.json", "kodo/backend1/package-lock.json"],
  // Next.js STANDALONE output: a traced, self-contained server. Shipping the
  // ordinary build instead meant carrying its whole 730 MB node_modules tree,
  // which made the tarball 602 MB. Standalone is ~37 MB and runs the same UI.
  //
  // keepNodeModules: standalone's whole point is the traced node_modules it
  // emits. The blanket source-copy filter stripped it, producing a UI that
  // installed cleanly and then exited 1 on first start with a missing module.
  ["chatbot/my-chatbot-ui/.next/standalone", "kodo/ui", { keepNodeModules: true }],
  ["chatbot/my-chatbot-ui/.next/static", "kodo/ui/.next/static"],
  ["chatbot/my-chatbot-ui/public", "kodo/ui/public"],
  ["docs", "kodo/docs"],
  ["README.md", "kodo/README.md"],
  ["install.sh", "kodo/install.sh"],
];

// Anything matching these is refused even if it sits inside a listed directory.
// A release that leaks a credential is worse than no release.
// Refused in the SOURCE copy. node_modules is excluded here and installed
// cleanly into the staging directory afterwards, so the artifact carries a
// production-only dependency tree rather than a developer's working one.
const FORBIDDEN = [/(^|\/)\.env($|\.)/, /\.db($|-wal$|-shm$)/, /(^|\/)\.kodo\//, /(^|\/)node_modules\//, /(^|\/)uploads\//];

// Refused in the FINAL artifact. node_modules is expected by then; credentials
// and databases never are.
//
// The directory patterns are ANCHORED to Kodo's own tree. Matching `uploads/`
// anywhere flagged `openai/resources/uploads/` inside a vendored dependency —
// a false positive that would have blocked every release. A credential check
// that cries wolf gets disabled, so it has to be precise.
const FORBIDDEN_IN_ARTIFACT = [
  /(^|\/)\.env($|\.)/,            // never, anywhere
  /\.db($|-wal$|-shm$)/,           // never, anywhere
  /^kodo\/backend1\/\.kodo\//,     // Kodo's own state, not a dependency's
  /^kodo\/backend1\/uploads\//,
  /^kodo\/\.kodo\//,
];

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function copyInto(stage) {
  for (const [from, to, opts = {}] of PAYLOAD) {
    const src = path.join(REPO, from);
    if (!fs.existsSync(src)) {
      console.warn(`  ! skipping missing ${from}`);
      continue;
    }
    const dest = path.join(stage, to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true, filter: (s) => {
      const rel = path.relative(REPO, s).replace(/\\/g, "/");
      const rules = opts.keepNodeModules
        ? FORBIDDEN.filter((re) => !String(re).includes("node_modules"))
        : FORBIDDEN;
      return !rules.some((re) => re.test(rel));
    } });
  }
}

/** Fail the build rather than ship a secret. */
function auditStage(stage) {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(stage, full).replace(/\\/g, "/");
      if (entry.isDirectory()) { walk(full); continue; }
      if (FORBIDDEN_IN_ARTIFACT.some((re) => re.test(rel))) { offenders.push(rel); continue; }
      // Cheap content scan for obvious credential shapes. Skipped inside
      // node_modules: scanning tens of thousands of vendored files is slow and
      // a third-party package's test fixture is not our secret.
      if (!rel.includes("node_modules/") && /\.(mjs|js|json|md|sh)$/.test(entry.name)) {
        const text = fs.readFileSync(full, "utf-8");
        if (/\bsk-[A-Za-z0-9]{20,}/.test(text)) offenders.push(`${rel} (contains an API-key-shaped string)`);
      }
    }
  };
  walk(stage);
  if (offenders.length) {
    throw new Error(`Refusing to build a release containing:\n  ${offenders.join("\n  ")}`);
  }
}

/**
 * GNU tar can pin mtime/owner so two builds of the same commit hash
 * identically. bsdtar (macOS) cannot, and errors on those flags. Use them when
 * available, and say so when not — a checksum that only reproduces on Linux is
 * still a valid integrity check, it is just not a reproducibility guarantee.
 */
function detectTarFlags() {
  try {
    const version = execFileSync("tar", ["--version"], { encoding: "utf-8" });
    if (/GNU tar/i.test(version)) {
      return {
        flags: ["--format=ustar", "--numeric-owner", "--owner=0", "--group=0", "--mtime=UTC 2020-01-01", "--sort=name"],
        reproducible: true,
      };
    }
  } catch { /* no --version support; treat as bsdtar */ }
  return { flags: [], reproducible: false };
}

/**
 * Install production dependencies INTO the artifact.
 *
 * The installer used to run `npm install` on the user's machine after
 * unpacking. That made "installed" mean "installed, if npm works, if the
 * registry is up, and if you are willing to wait" — a release that needs a
 * package manager at install time is not a release, it is a build script with
 * extra steps.
 *
 * Bundling has a real consequence and it is the reason the artifacts are
 * per-platform: better-sqlite3 is a NATIVE module, so these dependencies are
 * compiled against THIS machine's platform and Node ABI. An artifact built on
 * macOS arm64 is genuinely only valid for macOS arm64. Building the other
 * targets requires running this script on those platforms — see
 * .github/workflows/release.yml.
 */
function bundleDependencies(stage) {
  const backend = path.join(stage, "kodo", "backend1");
  if (!fs.existsSync(path.join(backend, "package.json"))) return;

  console.log("  … installing production dependencies into the artifact");
  execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts=false"], {
    cwd: backend,
    stdio: ["ignore", "ignore", "inherit"],
  });

  // Prove the native module actually works here, rather than discovering it on
  // a user's machine.
  const check = execFileSync(process.execPath, [
    "-e", "require('better-sqlite3'); console.log('ok')",
  ], { cwd: backend, encoding: "utf-8" });
  if (!check.includes("ok")) throw new Error("the bundled better-sqlite3 does not load on this platform");

  // The UI needs nothing installed: standalone already carries its traced
  // dependencies. Verify the server entry point survived the copy rather than
  // discovering it missing when a user runs `kodo ui start`.
  const uiServer = path.join(stage, "kodo", "ui", "server.js");
  if (!fs.existsSync(uiServer)) {
    throw new Error(
      "The UI standalone server is missing from the artifact.\n" +
      "Run `npm run ui:build` first — the build must produce .next/standalone " +
      '(next.config.ts sets output: "standalone").',
    );
  }
}

function main() {
  const { flags: tarFlags, reproducible } = detectTarFlags();

  console.log(`\nBuilding Kodo ${VERSION} release artifacts`);
  console.log(`  output: ${OUT}`);
  console.log(`  tar:    ${reproducible ? "GNU (reproducible)" : "bsdtar (NOT byte-reproducible across machines)"}\n`);

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "kodo-release-"));
  try {
    copyInto(stage);
    bundleDependencies(stage);
    auditStage(stage);
    console.log("  ✓ payload staged and audited (no credentials, no node_modules)");

    const sums = [];
    for (const platform of PLATFORMS) {
      const name = `kodo-${VERSION}-${platform}.tar.gz`;
      const target = path.join(OUT, name);
      // Reproducibility flags are GNU tar's; macOS ships bsdtar, which rejects
      // them. Detected rather than assumed, because a build script that only
      // works on the maintainer's laptop is not a release pipeline.
      execFileSync("tar", [...tarFlags, "-czf", target, "-C", stage, "kodo"], {
        stdio: "inherit",
        // Stops macOS writing ._AppleDouble resource-fork entries into the
        // archive, which would differ between machines and break the checksum.
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      });
      const digest = sha256(target);
      sums.push(`${digest}  ${name}`);
      console.log(`  ✓ ${name}  ${(fs.statSync(target).size / 1024).toFixed(0)} KB`);
    }

    fs.writeFileSync(path.join(OUT, "SHA256SUMS"), `${sums.join("\n")}\n`);
    fs.writeFileSync(path.join(OUT, "latest.txt"), `${VERSION}\n`);
    console.log("  ✓ SHA256SUMS");
    console.log("  ✓ latest.txt");

    console.log(`\nServe these for a release install:\n`);
    console.log(`  mkdir -p /tmp/kodo-releases/releases/${VERSION}`);
    console.log(`  cp ${OUT}/*.tar.gz ${OUT}/SHA256SUMS /tmp/kodo-releases/releases/${VERSION}/`);
    console.log(`  cp ${OUT}/latest.txt /tmp/kodo-releases/releases/`);
    console.log(`  (cd /tmp/kodo-releases && python3 -m http.server 8000)`);
    console.log(`  KODO_BASE_URL=http://127.0.0.1:8000 sh install.sh\n`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

main();
