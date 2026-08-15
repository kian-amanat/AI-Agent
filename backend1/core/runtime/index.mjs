/**
 * core/runtime/index.mjs — choosing a runtime, and refusing to lie about it.
 *
 * One rule governs this file:
 *
 *   IF A SANDBOX WAS REQUESTED AND CANNOT BE PROVEN, THE RUN DOES NOT START.
 *
 * There is no fallback to the host. A silent downgrade is the single worst
 * outcome available here — worse than an error, and much worse than refusing to
 * offer the flag at all — because the user asked for confinement, was not told
 * they did not get it, and then pointed an autonomous agent at their machine.
 *
 * "Proven" means empirical, at startup, on this machine, right now:
 * `verifyIsolation()` writes a file and looks for it, counts the processes the
 * container can see, and checks the host filesystem is unreachable. Not "did we
 * pass the right flags" — flags express intent, not outcome.
 */

import { assertRuntime } from "./contract.mjs";
import { HostRuntime } from "./host.mjs";

export { HostRuntime } from "./host.mjs";
export { DockerRuntime, dockerAvailable } from "./docker.mjs";
export { IncusRuntime, incusAvailable } from "./incus.mjs";
export { assertRuntime, RUNTIME_METHODS, toRelativePosix } from "./contract.mjs";

/** Sandboxes a user may ask for by name. "host" is the absence of one. */
export const SANDBOX_KINDS = Object.freeze(["host", "docker", "incus"]);

/**
 * Sandboxes whose isolation has been PROVEN against live infrastructure.
 *
 * Incus is implemented and structurally identical to Docker, but the Incus
 * daemon is Linux-only and has never been run against by this codebase's test
 * suite — `tests/incusRuntime.test.mjs` skips its live section everywhere it
 * has been executed. An implementation nobody has ever watched work is not a
 * verified security boundary, and `--sandbox` is a security claim.
 *
 * So it is not advertised. It still WORKS if you ask for it explicitly, on a
 * machine that has Incus, via KODO_ENABLE_UNVERIFIED_INCUS=1 — that opt-in is
 * how someone with a Linux host can run the live suite and close this out.
 * Until that happens, offering it in `--help` alongside Docker would imply a
 * parity of evidence that does not exist.
 */
export const VERIFIED_SANDBOXES = Object.freeze(["host", "docker"]);

export const INCUS_OPT_IN = "KODO_ENABLE_UNVERIFIED_INCUS";

export function isSandboxKind(value) {
  return SANDBOX_KINDS.includes(value);
}

/** What `--help`, `kodo doctor` and the docs may present as available. */
export function advertisedSandboxes() {
  return process.env[INCUS_OPT_IN] === "1" ? [...SANDBOX_KINDS] : [...VERIFIED_SANDBOXES];
}

/**
 * Build and START a runtime, verifying isolation when one was requested.
 *
 * @param {object} options
 * @param {string} options.root       workspace root on the host
 * @param {string} [options.sandbox]  "host" | "docker" | "incus"
 * @param {object} [options.config]   runtime-specific settings (image, network…)
 * @param {(msg: string) => void} [options.onProgress]
 * @returns {Promise<ExecutionRuntime>} started, and verified when sandboxed
 */
export async function createRuntime({
  root,
  sandbox = "host",
  config = {},
  onProgress = null,
} = {}) {
  if (!root) throw new Error("createRuntime requires a workspace root");
  if (!isSandboxKind(sandbox)) {
    throw new Error(`Unknown sandbox "${sandbox}". Available: ${advertisedSandboxes().join(", ")}.`);
  }

  // Refuse an unverified sandbox unless the operator has explicitly accepted
  // that it is unverified. This is not a capability check — Incus may well work
  // fine on their machine — it is a claims check: Kodo must not imply that
  // `--sandbox incus` carries the same evidence as `--sandbox docker`.
  if (sandbox === "incus" && process.env[INCUS_OPT_IN] !== "1") {
    throw new Error(
      "The Incus runtime is implemented but its isolation has NOT been verified against a live " +
      "Incus daemon, so Kodo does not offer it as a supported sandbox.\n" +
      `If you have Incus and accept that, set ${INCUS_OPT_IN}=1 to use it. It still fails closed: ` +
      "isolation is verified empirically at startup either way.\n" +
      "See docs/incus.md for what would be needed to close this out.",
    );
  }

  if (sandbox === "host") {
    const runtime = new HostRuntime({ root });
    assertRuntime(runtime);
    await runtime.start();
    return runtime;
  }

  const notify = (msg) => { try { onProgress?.(msg); } catch { /* reporting must not break startup */ } };

  let runtime;
  if (sandbox === "docker") {
    const { DockerRuntime } = await import("./docker.mjs");
    runtime = new DockerRuntime({ root, ...config });
  } else {
    const { IncusRuntime } = await import("./incus.mjs");
    runtime = new IncusRuntime({ root, ...config });
  }
  assertRuntime(runtime);

  notify(`starting the ${sandbox} sandbox…`);
  try {
    await runtime.start();
  } catch (err) {
    // Starting failed. Do not continue on the host — the caller asked for a
    // sandbox, and running without one is a different (and unrequested) thing.
    throw new Error(
      `Could not start the ${sandbox} sandbox: ${err.message}\n` +
      "Kodo will not run on the host when a sandbox was requested. " +
      "Fix the sandbox, or re-run without --sandbox to use this machine explicitly.",
    );
  }

  notify("verifying isolation…");
  let report;
  try {
    report = await runtime.verifyIsolation();
  } catch (err) {
    await runtime.cleanup().catch(() => {});
    throw new Error(`Could not verify ${sandbox} isolation: ${err.message}. Refusing to run.`);
  }

  if (!report?.isolated) {
    await runtime.cleanup().catch(() => {});
    throw new Error(
      `The ${sandbox} sandbox could not prove isolation: ${report?.reason || "unknown reason"}.\n` +
      `Checks that did pass: ${report?.checks?.join("; ") || "none"}.\n` +
      "Refusing to run — a sandbox that cannot be verified is not a sandbox.",
    );
  }

  for (const check of report.checks) notify(`  ✓ ${check}`);
  return runtime;
}

/**
 * What this machine can actually offer, probed rather than assumed.
 * `kodo doctor` and `--help` use this so the flag list reflects reality.
 */
export async function availableSandboxes() {
  const { dockerAvailable } = await import("./docker.mjs");
  const { incusAvailable } = await import("./incus.mjs");
  const [docker, incus] = await Promise.all([
    dockerAvailable().catch(() => false),
    incusAvailable().catch(() => false),
  ]);
  return {
    host: true,
    docker,
    incus,
  };
}
