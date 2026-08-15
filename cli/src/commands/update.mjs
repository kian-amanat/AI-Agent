/**
 * src/commands/update.mjs — `kodo update`.
 *
 * Kodo has two installation shapes and this command has to be honest about
 * which one you have:
 *
 *   SOURCE   installed by install.sh from a checkout (the supported path
 *            today). Updating means updating that checkout — `git pull` plus
 *            a dependency install. This command does it, and reports what it
 *            actually did.
 *
 *   RELEASE  installed from a published, checksum-verified tarball. Fully
 *            implemented in install.sh, but there is no release host yet.
 *            Rather than pretend, this command says so and points at the
 *            source path.
 *
 * The alternative — inventing a release URL so `kodo update` "works" — would
 * produce a command that always fails with a 404 and documentation describing
 * an artifact nobody can download.
 */

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";

import { parseArgs } from "../args.mjs";
import { EXIT, CliError } from "../exit.mjs";
import { out, log, style, ok, warn } from "../term.mjs";
import { coreEntry } from "../core.mjs";
import { kodoHome } from "../paths.mjs";

const execFileAsync = promisify(execFile);

const SPEC = {
  json:    { type: "boolean" },
  check:   { type: "boolean" },
  help:    { type: "boolean", short: "h" },
  color:   { type: "boolean", default: true },
  verbose: { type: "boolean" },
  debug:   { type: "boolean" },
};

/** Where this Kodo actually lives, and how it got there. */
/**
 * Is this Kodo running from inside a node_modules tree, and if so which package?
 *
 * `<prefix>/lib/node_modules/<name>` is a global install; anything else under a
 * node_modules directory is a local/dev-dependency install. Both are npm's to
 * manage.
 */
function findNpmPackageRoot(start) {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const parent = path.dirname(dir);
    if (path.basename(parent) === "node_modules"
        || path.basename(path.dirname(parent)) === "node_modules") {
      // dir (or its parent, for a scoped package) is the package root.
      const pkgRoot = path.basename(parent) === "node_modules" ? dir : parent;
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf-8"));
        const nodeModules = path.basename(parent) === "node_modules" ? parent : path.dirname(parent);
        return {
          root: pkgRoot,
          name: manifest.name,
          global: path.basename(path.dirname(nodeModules)) === "lib"
            || nodeModules.includes(path.join("lib", "node_modules")),
        };
      } catch { return null; }
    }
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function detectInstallation() {
  // install.sh's launcher exports this, so it is present for a source install
  // and absent for `node cli/bin/kodo.mjs` run directly out of a repo.
  const fromLauncher = process.env.KODO_SOURCE_DIR || "";
  const entry = coreEntry();
  const root = fromLauncher || (entry ? path.resolve(path.dirname(entry), "..", "..") : "");

  if (!root || !fs.existsSync(root)) {
    return { kind: "unknown", root: null };
  }

  // A RELEASE install lives in a versioned directory under the user's data
  // dir; a SOURCE install is a checkout. Telling them apart matters: uninstall
  // offers to delete a release directory (Kodo put it there) but must never
  // offer to delete a checkout (the user did).
  //
  // Without this both were reported as "source", so uninstalling a release left
  // 55 MB behind and told the user it was their own source tree.
  // An NPM install lives inside a node_modules tree. Detecting it first matters
  // because npm OWNS those files: Kodo must not move, replace or delete them,
  // it must tell npm to. Everything else here would happily rewrite the
  // directory in place, which is how a package manager and a tool end up
  // disagreeing about what is installed.
  const npmPackage = findNpmPackageRoot(root);
  if (npmPackage) {
    return {
      kind: "npm",
      root: npmPackage.root,
      packageName: npmPackage.name,
      global: npmPackage.global,
      releaseHost: null,
    };
  }

  const libDir = path.join(process.env.HOME || "", ".local", "share", "kodo");
  const isRelease = root.startsWith(libDir + path.sep);
  const isGit = fs.existsSync(path.join(root, ".git"));

  return {
    kind: isRelease ? "release" : isGit ? "source-git" : "source",
    root,
    version: isRelease ? path.basename(root) : null,
    libDir: isRelease ? libDir : null,
    launcher: Boolean(fromLauncher),
    releaseHost: process.env.KODO_BASE_URL || null,
  };
}

/** The latest published version, or null if the registry cannot be reached. */
async function npmLatest(pkg) {
  const res = await run("npm", ["view", pkg, "version"]);
  const version = res.stdout.trim();
  return res.ok && /^\d+\.\d+\.\d+/.test(version) ? version : null;
}

async function run(bin, args, cwd) {
  try {
    const { stdout } = await execFileAsync(bin, args, { cwd, timeout: 300_000 });
    return { ok: true, stdout: stdout.trim(), error: "" };
  } catch (err) {
    return { ok: false, stdout: "", error: String(err.stderr || err.message).trim() };
  }
}

async function git(args, cwd) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 120_000 });
    return { ok: true, stdout: stdout.trim() };
  } catch (err) {
    return { ok: false, stdout: "", error: String(err.stderr || err.message).trim() };
  }
}

export async function updateCommand({ argv, version }) {
  const { flags } = parseArgs(argv, SPEC);
  const install = detectInstallation();

  if (flags.json) {
    out(JSON.stringify({ ok: true, version, installation: install.kind, root: install.root }, null, 2));
    return EXIT.OK;
  }

  log(style.bold("Kodo update"));
  log("");
  log(`  Installed version: ${version}`);
  log(`  Installation:      ${install.kind}${install.root ? ` (${install.root})` : ""}`);
  log("");

  // npm owns this installation — hand the operation to npm rather than
  // rewriting files underneath it. Doing it ourselves would leave npm's
  // metadata describing a version that is no longer on disk, and the next
  // `npm install -g` would "fix" it by overwriting whatever we did.
  if (install.kind === "npm") {
    const pkg = install.packageName || "kodo-agent";
    const latest = await npmLatest(pkg);

    if (!latest) {
      warn(`could not reach the npm registry to check for a newer ${pkg}.`);
      log(style.dim(`  Update manually: npm install -g ${pkg}@latest`));
      return EXIT.OK;
    }

    log(`  Latest on npm:     ${latest}`);
    log("");

    if (latest === version) {
      ok("Kodo is already up to date.");
      return EXIT.OK;
    }

    if (flags.check) {
      log(`  A newer version is available: ${version} → ${latest}`);
      log(style.dim(`  Update with: kodo update   (or: npm install -g ${pkg}@latest)`));
      return EXIT.OK;
    }

    log(`  Updating ${version} → ${latest} …`);
    log("");
    const args = ["install", install.global ? "-g" : null, `${pkg}@latest`].filter(Boolean);
    const res = await run("npm", args);
    if (!res.ok) {
      throw new CliError(
        `npm could not update ${pkg}: ${res.error}`,
        EXIT.RUNTIME,
        {
          hint: /EACCES|permission/i.test(res.error)
            ? `Your global npm directory is not writable. Prefer fixing npm's prefix over sudo:\n` +
              `    npm config set prefix ~/.npm-global\n` +
              `    export PATH="$HOME/.npm-global/bin:$PATH"\n` +
              `  then re-run: npm install -g ${pkg}@latest`
            : `Run it yourself: npm install -g ${pkg}@latest`,
        },
      );
    }

    ok(`Kodo updated to ${latest}`);
    log(style.dim("  Your configuration in ~/.kodo was not touched."));
    return EXIT.OK;
  }

  if (install.kind === "unknown") {
    throw new CliError(
      "Could not determine how this Kodo was installed.",
      EXIT.CONFIG,
      { hint: "Re-run install.sh from a Kodo checkout, or set KODO_SOURCE_DIR." },
    );
  }

  // No release channel exists yet. Say that plainly instead of failing on a
  // fabricated URL.
  if (!install.releaseHost) {
    log(style.dim("  No release channel is configured (KODO_BASE_URL is unset)."));
    log(style.dim("  Kodo has no published binary releases yet, so updates come from source."));
    log("");
  }

  if (install.kind !== "source-git") {
    warn("this installation is not a git checkout, so it cannot be updated automatically.");
    log(style.dim(`  Replace ${install.root} with a newer checkout and re-run install.sh.`));
    return EXIT.OK;
  }

  const before = (await git(["rev-parse", "--short", "HEAD"], install.root)).stdout;

  // --check runs BEFORE the clean-tree requirement: reporting whether an
  // update exists is read-only, and refusing to answer that question because
  // you have uncommitted work would be gratuitous.
  if (flags.check) {
    const fetched = await git(["fetch", "--quiet"], install.root);
    if (!fetched.ok) throw new CliError(`git fetch failed: ${fetched.error}`, EXIT.RUNTIME);
    const behind = (await git(["rev-list", "--count", "HEAD..@{u}"], install.root)).stdout || "0";
    log(Number(behind) > 0
      ? style.yellow(`  ${behind} update(s) available. Run \`kodo update\` to apply.`)
      : style.green("  Kodo is up to date."));
    log("");
    return EXIT.OK;
  }

  const status = await git(["status", "--porcelain"], install.root);
  if (!status.ok) {
    throw new CliError(`Could not read the checkout: ${status.error}`, EXIT.RUNTIME);
  }
  if (status.stdout) {
    // Refusing beats clobbering: an update that discards uncommitted work is
    // worse than one that does not run.
    throw new CliError(
      `${install.root} has uncommitted changes.`,
      EXIT.RUNTIME,
      { hint: "Commit or stash them first — `kodo update` will not discard local work." },
    );
  }

  log(style.dim("  pulling…"));
  const pulled = await git(["pull", "--ff-only"], install.root);
  if (!pulled.ok) {
    throw new CliError(
      `git pull failed: ${pulled.error}`,
      EXIT.RUNTIME,
      { hint: "Resolve the checkout by hand, then re-run `kodo update`." },
    );
  }

  const after = (await git(["rev-parse", "--short", "HEAD"], install.root)).stdout;
  if (before === after) {
    ok("Kodo is already up to date.");
    log("");
    return EXIT.OK;
  }

  // Dependencies may have changed with the code.
  log(style.dim("  installing dependencies…"));
  try {
    await execFileAsync("npm", ["--prefix", path.join(install.root, "backend1"), "install", "--no-audit", "--no-fund"], { timeout: 600_000 });
  } catch (err) {
    warn(`dependency install failed: ${String(err.message).split("\n")[0]}`);
    log(style.dim(`  Run it by hand: npm --prefix ${path.join(install.root, "backend1")} install`));
  }

  ok(`Updated ${before} → ${after}`);
  log("");
  log(style.dim(`  Your configuration in ${kodoHome()} was not touched.`));
  log(style.dim("  Run `kodo doctor` to confirm the installation is healthy."));
  log("");
  return EXIT.OK;
}
