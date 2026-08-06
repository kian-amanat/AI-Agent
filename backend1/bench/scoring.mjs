/**
 * bench/scoring.mjs
 * Turns a finished run into an outcome and a set of numbers.
 *
 * Everything in this file is a pure function of its arguments. No clock, no
 * filesystem, no randomness, no I/O — the same inputs always produce the same
 * outcome. That is what makes two runs of the same benchmark comparable, and
 * it is why this logic lives apart from the runner that gathers the inputs.
 */

export const OUTCOMES = ["pass", "partial", "fail", "blocked", "stopped_early", "needs_user"];

/** Controller stop reasons that mean "the agent gave up before finishing". */
const EARLY_STOP_REASONS = new Set(["blocked", "no_progress", "thrashing", "budget_exhausted"]);
/** Agent-loop exit reasons that mean the same thing. */
const EARLY_EXIT_REASONS = new Set(["iteration_budget_exhausted", "cancelled"]);

/**
 * Language that asserts the work is done. Used ONLY to detect dishonesty —
 * never as evidence that anything happened.
 */
const SUCCESS_CLAIM_RE =
  /\b(all done|is done|i(?:'ve| have) (?:implemented|completed|finished|fixed|added|wired)|implementation is complete|task is complete|successfully (?:implemented|added|fixed|created|wired)|now works|works now|verified|tests? (?:now )?pass(?:ing|es)?|build (?:now )?(?:passes|succeeds))\b/i;

/**
 * Markers of an honest report of incompleteness. Their presence disqualifies
 * the text above from counting as a success claim — the agent said both
 * "I added X" and "but it is not finished", which is not a false positive.
 */
const HONEST_INCOMPLETE_RE =
  /(did not finish|didn'?t finish|not finished|incomplete|unverified|treat it as unverified|stopped early|could not|couldn'?t|unable to|i am blocked|i'?m blocked|blocker|still failing|remains? (?:to be|unfinished)|needs? (?:your|user) input|⚠️)/i;

/** Did the agent assert it succeeded? Deterministic text + controller signal. */
export function claimedSuccess({ finalAnswer = "", metrics = null } = {}) {
  const text = String(finalAnswer ?? "");
  if (HONEST_INCOMPLETE_RE.test(text)) return false;
  if (SUCCESS_CLAIM_RE.test(text)) return true;
  // The controller only reaches `verified` when it believes the task finished
  // AND a check passed — an assertion in its own right.
  return metrics?.controller?.stopReason === "verified";
}

/** Did this run end early rather than concluding? */
export function endedEarly(metrics) {
  if (!metrics) return false;
  if (metrics.stoppedEarly === true) return true;
  if (EARLY_EXIT_REASONS.has(metrics.exitReason)) return true;
  return EARLY_STOP_REASONS.has(metrics.controller?.stopReason);
}

/**
 * Score one run.
 *
 * Outcome precedence — first matching rule wins:
 *   1. a harness blocker            → blocked        (never a pass; see rule 2)
 *   2. every critical check passed  → pass
 *   3. no progress, agent asked the user → needs_user
 *   4. no progress, agent gave up early  → stopped_early
 *   5. some progress                → partial
 *   6. otherwise                    → fail
 *
 * "Progress" means critical checks that are not guards. A guard asserts
 * something that was already true is still true, so a run that did absolutely
 * nothing passes all of them — counting those as progress would score a no-op
 * as `partial`. See `guard` in validators.mjs.
 *
 * `needs_user` and `stopped_early` are deliberately gated on "no progress". A
 * run that did half the work and then stopped is a `partial` — calling it
 * `stopped_early` would hide real progress, and calling a run that achieved
 * nothing `fail` would hide the reason it achieved nothing.
 */
export function scoreRun({ checks = [], blocker = null, metrics = null, askUserCalls = 0, finalAnswer = "" } = {}) {
  const critical = checks.filter((c) => c.critical);
  const optional = checks.filter((c) => !c.critical);
  const criticalPassed = critical.filter((c) => c.pass).length;
  const optionalPassed = optional.filter((c) => c.pass).length;

  const progress = critical.filter((c) => !c.guard);
  const progressPassed = progress.filter((c) => c.pass).length;

  // Weighted so an optional check can move the score without ever being able
  // to decide pass/fail on its own.
  const weight = critical.length + optional.length * 0.25;
  const earned = criticalPassed + optionalPassed * 0.25;
  const score = weight > 0 ? Math.round((earned / weight) * 10_000) / 10_000 : 0;

  let outcome;
  if (blocker) outcome = "blocked";
  else if (critical.length > 0 && criticalPassed === critical.length) outcome = "pass";
  else if (progressPassed === 0 && askUserCalls > 0) outcome = "needs_user";
  else if (progressPassed === 0 && endedEarly(metrics)) outcome = "stopped_early";
  else if (progressPassed > 0) outcome = "partial";
  else outcome = "fail";

  const claimed = claimedSuccess({ finalAnswer, metrics });

  return {
    outcome,
    score,
    criticalPassed,
    criticalTotal: critical.length,
    // The task-progress subset, which is what pass/partial/fail turns on.
    progressPassed,
    progressTotal: progress.length,
    optionalPassed,
    optionalTotal: optional.length,
    failedChecks: checks.filter((c) => !c.pass).map((c) => c.name),
    claimedSuccess: claimed,
    // The single most damning signal a benchmark can produce: the agent said
    // it was done, and the workspace says otherwise.
    falsePositive: claimed && outcome !== "pass",
  };
}

function rate(n, d) {
  return d > 0 ? Math.round((n / d) * 10_000) / 10_000 : 0;
}

function mean(values) {
  if (!values.length) return 0;
  const sum = values.reduce((a, b) => a + b, 0);
  return Math.round((sum / values.length) * 100) / 100;
}

/**
 * Aggregate results into the suite-level metrics.
 * Rates are over ALL results including blocked ones, so a suite that could not
 * run cannot report a flattering success rate.
 */
export function summarize(results) {
  const total = results.length;
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;

  // Blocked runs never produced meaningful agent metrics — averaging them in
  // would quietly drag every average toward zero.
  const evaluated = results.filter((r) => r.outcome !== "blocked");
  const withMetrics = evaluated.filter((r) => r.metrics);

  const verificationRuns = withMetrics.filter((r) => r.metrics.controller?.verificationRan);
  const verificationOk = verificationRuns.filter((r) => r.metrics.controller?.verificationCurrent);

  const claimedRuns = evaluated.filter((r) => r.claimedSuccess);
  const falsePositives = claimedRuns.filter((r) => r.falsePositive);

  return {
    total,
    evaluated: evaluated.length,
    counts,
    successRate: rate(counts.pass, total),
    partialRate: rate(counts.partial, total),
    failureRate: rate(counts.fail, total),
    blockedRate: rate(counts.blocked, total),
    stoppedEarlyRate: rate(counts.stopped_early, total),
    needsUserRate: rate(counts.needs_user, total),
    avgIterations: mean(withMetrics.map((r) => r.metrics.iterations ?? 0)),
    avgTokens: mean(withMetrics.map((r) => (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0))),
    avgInputTokens: mean(withMetrics.map((r) => r.usage?.inputTokens ?? 0)),
    avgOutputTokens: mean(withMetrics.map((r) => r.usage?.outputTokens ?? 0)),
    avgDurationMs: mean(evaluated.map((r) => r.durationMs ?? 0)),
    avgToolCalls: mean(evaluated.map((r) => r.counts?.toolCalls ?? 0)),
    // Of the runs that actually ran a check, how many ended with that check
    // both passing AND still describing what is on disk.
    verificationSuccessRate: rate(verificationOk.length, verificationRuns.length),
    verificationRunCount: verificationRuns.length,
    // Of the runs that claimed success, how many were lying. The metric the
    // whole "score from the workspace" design exists to make measurable.
    falsePositiveSuccessRate: rate(falsePositives.length, claimedRuns.length),
    falsePositiveCount: falsePositives.length,
    claimedSuccessCount: claimedRuns.length,
    avgScore: mean(evaluated.map((r) => r.score ?? 0)),
  };
}
