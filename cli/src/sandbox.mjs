/**
 * src/sandbox.mjs — the `--sandbox` flag.
 *
 * Thin on purpose. All the judgement lives in core/runtime/index.mjs, which
 * refuses to return a runtime that could not prove isolation. This file's only
 * jobs are to validate the flag, report progress, and make sure the runtime is
 * torn down — including when the task fails or the user hits Ctrl+C, because a
 * leaked container is a leaked copy of the user's source code.
 *
 * The flag is only offered because tests/dockerRuntime.test.mjs proves that
 * file operations, not merely `bash`, execute inside the container. If that
 * proof ever stops holding, the flag should go, not the tests.
 */

import { CliError, EXIT, usageError } from "./exit.mjs";
import { log, style } from "./term.mjs";

export const SANDBOX_KINDS = ["host", "docker", "incus"];

/**
 * What is presented as available.
 *
 * Incus is implemented but its isolation has never been verified against a live
 * daemon (Linux-only; see docs/incus.md). Listing it beside Docker in `--help`
 * would imply the same evidence backs both, and `--sandbox` is a security
 * claim. It stays usable behind KODO_ENABLE_UNVERIFIED_INCUS=1.
 */
export const VERIFIED_SANDBOX_KINDS = ["host", "docker"];

export function advertisedKinds() {
  return process.env.KODO_ENABLE_UNVERIFIED_INCUS === "1" ? SANDBOX_KINDS : VERIFIED_SANDBOX_KINDS;
}

/**
 * @returns {Promise<{runtime: object|null, dispose: () => Promise<void>}>}
 *   `runtime: null` means the host, which is the default and is passed through
 *   to the agent as "no runtime override".
 */
export async function openSandbox({ core, sandbox, workspace, quiet = false, json = false }) {
  const kind = sandbox || "host";

  if (!SANDBOX_KINDS.includes(kind)) {
    throw usageError(
      `Unknown sandbox "${kind}".`,
      `Valid values: ${advertisedKinds().join(", ")}. Run \`kodo doctor\` to see which are available here.`,
    );
  }

  if (kind === "host") {
    return { runtime: null, dispose: async () => {} };
  }

  const notify = (msg) => { if (!quiet && !json) log(style.dim(`  ${msg}`)); };

  let runtime;
  try {
    runtime = await core.createRuntime({
      root: workspace,
      sandbox: kind,
      onProgress: notify,
    });
  } catch (err) {
    // core already refused rather than degrading; surface that verbatim, because
    // the distinction between "no sandbox" and "sandbox failed" is the whole
    // point and paraphrasing it would blur it.
    throw new CliError(err.message, EXIT.PERMISSION, {
      hint: "Re-run without --sandbox to use this machine directly, and only if you intend that.",
    });
  }

  if (!quiet && !json) {
    log(style.green(`  ✓ ${kind} sandbox verified — files and processes are confined`));
    log("");
  }

  let disposed = false;
  return {
    runtime,
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await runtime.cleanup();
      } catch (err) {
        // Say so loudly. A container that outlives the run holds a copy of the
        // user's source, and silently leaking it is worse than a noisy warning.
        log(style.yellow(`warning: could not clean up the ${kind} sandbox: ${err.message}`));
        log(style.dim(`  Remove it manually: ${kind === "docker" ? `docker rm -f ${runtime.containerName}` : `incus delete --force ${runtime.instance}`}`));
      }
    },
  };
}

/** Shared flag definition, so `run` and `chat` cannot drift apart. */
export const SANDBOX_FLAG = { sandbox: { type: "string" } };
