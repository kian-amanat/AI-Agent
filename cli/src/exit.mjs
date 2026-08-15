/**
 * src/exit.mjs — the CLI's exit-code contract.
 *
 * These are part of Kodo's public interface: scripts and CI branch on them, so
 * a code's meaning must not drift once released. `kodo run` in particular has
 * to distinguish "the agent tried and the task failed" (1) from "you invoked me
 * wrong" (2) from "the model provider rejected the credential" (4) — a single
 * non-zero code would make every one of those look like a failed task.
 */

export const EXIT = {
  OK: 0,
  /** The agent ran and the task did not succeed. */
  TASK_FAILURE: 1,
  /** Bad flags, unknown command, missing required argument. */
  USAGE: 2,
  /** Configuration is missing or invalid (no model, unreadable config file). */
  CONFIG: 3,
  /** The provider rejected us: no API key, bad key, auth error. */
  AUTH: 4,
  /** A permission or security boundary refused the action. */
  PERMISSION: 5,
  /** The local server / runtime could not start, stop, or be reached. */
  RUNTIME: 6,
};

/** Thrown by commands to exit with a specific code and a human-readable reason. */
export class CliError extends Error {
  constructor(message, code = EXIT.USAGE, { hint = "" } = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.hint = hint;
  }
}

export const usageError = (message, hint) => new CliError(message, EXIT.USAGE, { hint });
export const configError = (message, hint) => new CliError(message, EXIT.CONFIG, { hint });
export const authError = (message, hint) => new CliError(message, EXIT.AUTH, { hint });
export const runtimeError = (message, hint) => new CliError(message, EXIT.RUNTIME, { hint });
