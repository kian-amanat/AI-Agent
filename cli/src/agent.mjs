/**
 * src/agent.mjs — the CLI's single call into the agent.
 *
 * `kodo run` and `kodo chat` both come through here, and here calls
 * core.runAgent, which is graph_runner.runKodoGraph — the same function the
 * HTTP route and the benchmark driver call. There is exactly one agent loop in
 * Kodo and this file does not add a second one; it wires terminal concerns
 * (rendering, Ctrl+C, stdin answers) to the parameters the agent already takes.
 */

import { setMaxListeners } from "events";

import { EVENT } from "./events.mjs";
import * as sessions from "./sessions.mjs";
import { style, log, routeConsoleToStderr } from "./term.mjs";

/**
 * @returns {{finalAnswer, editedFiles, usage, runMetrics, cancelled}}
 */
export async function runTurn({
  core,
  session,
  message,
  workspace,
  modelRoute,
  permissionMode = "auto",
  renderer,
  askUser = null,
  signal = null,
  runtime = null,
}) {
  const requestId = `cli_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  // The agent narrates itself on console.log; on a CLI that belongs on stderr.
  routeConsoleToStderr();

  const controller = new AbortController();
  // The agent attaches one abort listener per tool invocation, which trips
  // Node's default 10-listener leak warning on any non-trivial run. The
  // listeners are real and intentional, so raise the ceiling rather than
  // printing a memory-leak warning at the user for normal operation.
  setMaxListeners(200, controller.signal);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });

  // The agent's working memory for the NEXT turn is built from these rows, so
  // record them before the run rather than reconstructing afterwards — a run
  // interrupted halfway must still leave behind what it actually did.
  const recordEvent = (event) => {
    try {
      sessions.recordEvent(session, { ...event, requestId });
    } catch (err) {
      // Losing a trace row must never abort real work.
      log(style.gray(`  (could not record trace: ${err.message})`));
    }
  };

  const priorConversation = await sessions.priorConversation(core, session);

  sessions.recordEvent(session, { kind: "user", content: message, requestId });
  sessions.save(session);

  renderer.event({ type: EVENT.SESSION_STARTED, sessionId: session.id, requestId, workspace });

  let collected = "";
  const emit = (event) => {
    if (event?.type === "content") collected += String(event.content ?? "");
    renderer.emit(event);
  };

  let result;
  try {
    result = await core.runAgent({
      userMessage: message,
      sessionId: session.id,
      requestId,
      // The graph threads userId through to memory writes only; a CLI install is
      // single-user by construction, so it is a constant rather than an account.
      userId: "cli",
      workspacePath: workspace,
      modelRoute,
      // No vision route: the CLI has no attachment upload path yet, and
      // resolveVisionCreds deliberately refuses to guess one. An image-requiring
      // step simply stays unavailable rather than being run against a model
      // never confirmed to support images.
      visionRoute: { ok: false },
      priorConversation,
      recordEvent,
      permissionMode,
      askUser,
      // The ExecutionRuntime every tool runs through. null means the host.
      // A sandboxed run gets one from core.createRuntime(), which refuses to
      // return anything that could not prove isolation.
      runtime,
      abortSignal: controller.signal,
      emit,
    });
  } finally {
    signal?.removeEventListener("abort", abort);
  }

  const finalAnswer = result?.finalAnswer || "";
  const editedFiles = Array.isArray(result?.editedFiles) ? result.editedFiles : [];

  // The saved transcript must equal what the user saw. `finalAnswer` is only
  // the last turn's text; the streamed total is the real message.
  const assistantText = collected.trim() || finalAnswer;
  sessions.recordEvent(session, { kind: "assistant", content: assistantText, requestId });
  session.turns += 1;
  if (!session.title && message) session.title = message.slice(0, 80);
  sessions.save(session);

  const cancelled = controller.signal.aborted;
  const providerError = result?.runMetrics?.providerError ?? null;

  renderer.event({
    type: EVENT.SESSION_COMPLETED,
    sessionId: session.id,
    requestId,
    // A provider failure is NOT success, even though the agent politely
    // explains it in prose and that prose is a non-empty finalAnswer. A
    // consumer of the JSON stream has to be able to see the difference.
    success: !cancelled && !providerError && Boolean(finalAnswer),
    providerError: providerError ? { message: providerError.message, salvaged: Boolean(providerError.salvaged) } : null,
    cancelled,
    editedFiles,
    usage: result?.usage ?? null,
  });

  return {
    finalAnswer,
    editedFiles,
    usage: result?.usage ?? null,
    runMetrics: result?.runMetrics ?? null,
    // The agent records a provider failure rather than only rendering it into
    // prose. Surfaced here so the CLI can exit with the RIGHT code: a quota or
    // auth rejection is not "the task failed", and a script must be able to
    // tell them apart.
    providerError,
    cancelled,
  };
}
