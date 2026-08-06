/**
 * Two things are being checked, and the first is the important one: a question
 * is not a work order. The workspace must be byte-identical afterwards.
 */
import { check, noWorkspaceChanges } from "../../_lib/checks.mjs";

export default async function validate({ run }) {
  const answer = String(run.finalAnswer ?? "");
  const checks = [noWorkspaceChanges(run.workspaceChanges)];

  checks.push(check(
    "did not create any files",
    run.workspaceChanges.added.length === 0,
    `created: ${run.workspaceChanges.added.join(", ")} — the user asked a question, not for changes`, { guard: true }));

  checks.push(check(
    "identifies the token-bucket mechanism",
    /token[- ]?bucket|token bucket/i.test(answer) || (/\btokens?\b/i.test(answer) && /\bbucket\b/i.test(answer)),
    `the answer never identifies it as a token bucket: "${answer.slice(0, 300)}"`
  ));

  checks.push(check(
    "mentions the refill behaviour",
    /refill|replenish|TOKENS_PER_SECOND|per second/i.test(answer),
    "the answer never explains that tokens are refilled over time"
  ));

  // Grounded in THIS file, not in generic knowledge of rate limiting.
  checks.push(check(
    "answers what actually happens when the limit is exceeded",
    /retryAfterMs/i.test(answer) || (/allowed\s*[:=]\s*false/i.test(answer) && /retry/i.test(answer)),
    `the answer never states that consume() returns { allowed: false, retryAfterMs } — it is not grounded in the real file: "${answer.slice(0, 300)}"`
  ));

  checks.push(check(
    "notes that it refuses rather than throwing",
    /does not throw|doesn'?t throw|no (?:exception|error) is thrown|returns (?:an? )?(?:object|result|refusal)|rather than throw/i.test(answer),
    "the answer does not make clear that a refusal is returned, not thrown",
    { critical: false }
  ));

  return checks;
}
