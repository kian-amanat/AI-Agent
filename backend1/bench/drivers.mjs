/**
 * bench/drivers.mjs
 * How a benchmark actually starts Kodo against a workspace.
 *
 * A driver is `async ({benchmark, workspace, prompt, recorder, signal}) =>
 * {finalAnswer, editedFiles, usage, runMetrics}`. Factoring it out this way is
 * what lets the framework's own tests exercise the full runner — workspace
 * isolation, transcript capture, validation, scoring, artifacts — end to end
 * against a scripted driver, with no API key and no billed calls, while the
 * real suite runs the identical code path against the real agent.
 *
 * `preflight()` is how a driver reports it cannot run at all. That answer
 * becomes a `blocked` result with the real reason attached, never a failure.
 */

/**
 * The real thing: router → answer/agent_loop, real model, real tools, against
 * the isolated benchmark workspace.
 */
/**
 * The credentials a benchmark run uses, read from the environment only.
 *
 * Passed to the graph as an explicit `modelRoute`, which is the highest
 * precedence branch in resolveCreds. That matters: the fallback path underneath
 * it reads `backend1/data/settings.json` — the app's own saved settings —
 * before it ever looks at env vars. A benchmark that inherited those would be
 * credentialed by whatever the UI was last configured with, while the run
 * report recorded whatever DEFAULT_MODEL happened to say. Two runs could then
 * differ in the one variable a comparison exists to hold constant, and the
 * artifact would not show it. So the runner states its credentials outright.
 */
export function benchCreds() {
  return {
    ok: true,
    apiKey: process.env.OPENAI_API_KEY || "",
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    model: process.env.DEFAULT_MODEL || "",
  };
}

export const kodoDriver = {
  name: "kodo",

  /**
   * What this driver will run against, minus the secret. The runner records it
   * in the report so a comparison can tell "Kodo got worse" apart from "the
   * model changed underneath us".
   */
  creds() {
    const { model, baseUrl } = benchCreds();
    return { model, baseUrl };
  },

  /** @returns {null | {stage: string, message: string}} */
  preflight() {
    const { apiKey, model } = benchCreds();
    const missing = [!apiKey && "OPENAI_API_KEY", !model && "DEFAULT_MODEL"].filter(Boolean);
    if (missing.length) {
      return {
        stage: "preflight",
        message:
          `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set. The benchmark runner drives the ` +
          "real agent loop and makes real, billed model calls. It deliberately does NOT fall back to the app's " +
          "saved settings (backend1/data/settings.json) — a run has to say which model it measured, or its results " +
          "cannot be compared to anything. Set OPENAI_API_KEY, DEFAULT_MODEL and OPENAI_BASE_URL (in backend1/.env " +
          "or the environment) and rerun.",
      };
    }
    return null;
  },

  async run({ benchmark, workspace, prompt, recorder, signal }) {
    // Imported here, not at module load: the agent's config layer constructs a
    // provider client on import and throws without credentials. Listing,
    // reporting, comparing and replaying must all work with no API key at all.
    const { runKodoGraph } = await import("../services/graph_runner.mjs");

    const result = await runKodoGraph({
      userMessage: prompt,
      sessionId: `bench_${benchmark.id}`,
      requestId: `bench_${benchmark.id}_${Date.now()}`,
      userId: "bench",
      workspacePath: workspace,
      // Explicit, from the environment — see benchCreds() above for why this is
      // not left to resolveCreds' fallback chain.
      modelRoute: benchCreds(),
      emit: recorder.emit,
      // Benchmark transcripts go to the recorder, NOT to turn_events. Nothing
      // a benchmark does enters the agent's live session memory.
      recordEvent: recorder.recordEvent,
      askUser: recorder.askUser,
      permissionMode: benchmark.metadata.permissionMode,
      abortSignal: signal,
    });

    return {
      finalAnswer: result?.finalAnswer ?? "",
      editedFiles: Array.isArray(result?.editedFiles) ? result.editedFiles : [],
      usage: result?.usage ?? null,
      runMetrics: result?.runMetrics ?? null,
    };
  },
};

/**
 * A driver built from a plain function. Used by the framework's own tests to
 * script agent behaviour (including misbehaviour: claiming success without
 * doing the work, stopping early, hitting a blocker) so scoring can be proven
 * against known-bad runs, not just hoped-for good ones.
 */
export function scriptedDriver(fn, { name = "scripted", preflight = () => null } = {}) {
  return { name, preflight, run: fn };
}

export const DRIVERS = { kodo: kodoDriver };
