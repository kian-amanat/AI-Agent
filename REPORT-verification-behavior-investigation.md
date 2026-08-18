# Kodo Verification-Behaviour Investigation

Investigation only. **Production files modified: NONE.** All diagnostics live in the session
scratchpad and import production modules read-only.

# 1. Executive Finding

**Primary cause: CONTROLLER_FLOW.** Kodo has a mandatory verification gate, and it is well built —
but it sits on a code path that 9 of these 10 runs never reached.

There are two ways a run can end, and only one of them enforces verification:

| Termination path | Trigger | Verification enforced? |
| --- | --- | --- |
| **Finish** (`agent_loop.mjs:3554`) | model emits a turn with **no tool calls** | **YES** — `canFinish()` returns `allowed:false` with a directive: *"You have not verified your changes, so you cannot finish yet."* |
| **no_progress** (`agent_loop.mjs:3690-3697`) | `noProgressStreak >= 3` | **NO** — `verdict.stop` → `break` immediately. `canFinish()` is never called. |

**9/10 runs terminated via the no_progress path.** The verification obligation was therefore never
requested, never pushed back on, and never enforced.

Worse, the two mechanisms are in direct conflict. The system prompt's VERIFY step instructs the
agent to *"read the sub-project you touched (its package.json / project config)"* and *"Re-read the
edited region too"* before running the command. The controller scores re-reading an already-read
file as **zero progress** during IMPLEMENTATION. So an agent that follows the documented verification
procedure accumulates a no-progress streak **by doing what it was told**, and is killed at three —
often before it reaches the `bash` call that VERIFY exists to produce.

# 2. Evidence From Qwen Runs

All five scored **8/8 PASS** by the validator. All five ran **zero bash commands**.

### q-fs-1 — full trace

```
 1. todo_write
 2. read_file  client/App.mjs
 3. read_file  server/api.mjs
 4. read_file  client/apiClient.mjs      ← UNDERSTAND (prompt step 1)
 5. edit_file  server/api.mjs
 6. todo_write
 7. edit_file  client/apiClient.mjs
 8. todo_write
 9. edit_file  client/App.mjs
10. edit_file  client/App.mjs            ← ACT (step 3) complete
11. todo_write
12. read_file  client/App.mjs            ← VERIFY (step 4): "Re-read the edited region"
13. read_file  server/api.mjs            ← streak reaches 3 here
14. read_file  client/apiClient.mjs
                                          → STOP: no_progress
                                          → canFinish() never called
                                          → no verification directive ever issued
```

q-fs-3 is identical in shape, stopping one turn later.

The agent was **interrupted during verification**, not after declining it. Calls 12-14 are precisely
the re-read half of the prompt's VERIFY step; the run ended before any `bash` call.

**Honest limit on this claim:** I cannot prove the model *would* have run a command next. What the
traces do prove is that (a) it was executing the documented VERIFY procedure, and (b) it was
terminated before reaching the gate that would have compelled the command. Whether it would have
gone on to run one is unknowable from these artifacts.

# 3. Evidence From Nano Runs

**Correcting an overstatement I made earlier:** I previously said "0/10 runs ran a real check". That
was wrong. Nano invoked bash in **2/5 runs (10 calls)** and recorded **5 verification events**; run
f-fs-5 even terminated with `stopReason: verified`, having reached a passing check.

| Run | bash calls | verifications recorded | stopReason |
| --- | ---: | ---: | --- |
| f-fs-1 | 0 | 0 | `no_progress` |
| f-fs-2 | 5 | 1 (`npm run lint \|\| echo …`, failed) | `no_progress` |
| f-fs-3 | 0 | 0 | `no_progress` |
| f-fs-4 | 0 | 0 | `no_progress` |
| f-fs-5 | 5 | 4 (last one passed) | **`verified`** |

f-fs-5 is the one run in ten that reached a verified terminal state — and its "pass" was against a
`server/package.json` build script the agent had written itself moments earlier, which the
controller's test-infra rule correctly refused to credit as evidence about the implementation.

So the accurate statement is: **agent-run verification producing valid evidence: 0/10. Verification
attempted: 2/10.**

# 4. Controller Flow

`endIteration()` (`taskController.mjs:1319`) → `assessProgress()` (`:1199`):

```
learnedSomething = inspectedPaths.size > mark.inspected   → false on a re-read
editedSomethingNew, firstVerification, diagnosticsMoved,
planAdvanced, unblocked                                    → all false while idling
phase = currentPhase() = "IMPLEMENTATION"   (state === "patch")
  └─ IMPLEMENTATION branch (:1245-1251): only learnedSomething can score
→ progressed = false → noProgressStreak++ → >= 3 → stop(NO_PROGRESS)  (:1438)
```

**Why the task stayed in IMPLEMENTATION despite every completion signal being true**
(`mutations 4 >= minMutatedFiles 2`, `openTodos []`, `unmet []`, `incompleteOnFinish false`):

`currentPhase()` is derived **solely from `state`**, and `state` advances `patch → verify` only via
`enter("verify")`, which fires only on a verification event. No verification ran, so `state` stayed
`patch` and `phase` stayed IMPLEMENTATION. **Completion signals have no influence on the phase.**
This is circular: you need verification to leave IMPLEMENTATION, and IMPLEMENTATION is the phase
whose no-progress rule kills you for performing verification's read step.

**What is supposed to cause the agent to enter verification:** the system prompt (step 4), and the
`canFinish()` gate as backstop. The gate is genuinely strict — `allowed:false` with a
task-appropriate directive, bounded by `MAX_VERIFY_PUSHBACKS = 2`. It simply is not on the
no_progress path.

# 5. Agent Loop Flow

- **Finish path** — `agent_loop.mjs:3554`: `if (!message.tool_calls?.length)` → `canFinish(...)`.
  Reached only when the model emits a text-only turn.
- **no_progress path** — `agent_loop.mjs:3690-3697`: `endIteration()` → `if (verdict.stop)` →
  `finalAnswer = blockerReport(); break;`. No gate consulted.

Successful edits do create a verification obligation — but it is **latent**, discharged only if the
model chooses to stop calling tools. The controller cannot *force* verification; it can only refuse
to let a finish through. An agent that keeps calling tools until the streak expires never encounters
it.

# 6. Prompt Analysis

The prompt is **imperative, not advisory**, and unusually specific (`agent_loop.mjs:2261-2267`):

> **4. VERIFY** — after code changes, check your work yourself: read the sub-project you touched
> (its package.json / project config) and run ITS actual typecheck, lint, build, or test command via
> bash … **Re-read the edited region too. Fix what you broke before finishing.**
> - Backend route/API work: start the server (run_in_background), then bash `curl` the actual
>   endpoint(s) you touched …

Step 5 FINISH adds honesty constraints: *"Only say 'verified' / 'tests pass' / '✅' if you actually
ran that check THIS turn and saw it pass."*

This is not a "you should verify" prompt — it is a "you MUST verify, here is exactly how for your
task type" prompt, and it covers this task's shape (backend route → curl the endpoint) explicitly.
**The prompt is not the defect.** Its instruction to re-read edited regions is, however, the exact
behaviour the controller punishes.

# 7. Tool Availability

Confirmed empirically against the live tool list:

```
bash exposed: true
bash desc: "Run a shell command in the workspace root (baseline allowlist: node, npm, npx,
            git, tsc, eslint, curl, ls, grep, …)"
total tools: 21
```

`KODO_DISABLE_BASH` was not set. Nano proved bash was callable and permitted in this exact fixture
(10 successful invocations including `npm`, `node`, `curl`). No run ever received a
"bash unavailable" error. **Tool availability is not the defect.**

# 8. Why Verification Did Not Happen

The causal chain, in order:

1. Agent completes edits. `state = patch`, `phase = IMPLEMENTATION`.
2. Agent begins the prompt's VERIFY step, which starts with re-reading edited regions and project
   config.
3. `assessProgress()` credits re-reads as **zero** in IMPLEMENTATION.
4. Three such turns → `noProgressStreak = 3` → `stop(NO_PROGRESS)`.
5. The loop `break`s immediately at `agent_loop.mjs:3696`. **`canFinish()` is never called.**
6. The mandatory verification directive is never issued; `finalAnswer` becomes `blockerReport()`.

The agent needed a verification event to escape IMPLEMENTATION, but was killed for doing
verification's preparatory reads while still inside it.

# 9. Root Cause Classification

**Primary: CONTROLLER_FLOW.** The verification obligation is enforced only at a gate the run never
reaches, and the no_progress rule actively terminates runs performing the documented VERIFY step.

**Secondary: MODEL_BEHAVIOR.** Qwen never invoked bash even once across 5 runs. Even granting the
interruption, a model following step 4 closely would have opened `package.json` via bash or run a
check earlier. Nano's 2/5 attempts show the loop does not prevent bash use. So model behaviour is a
real contributing factor — but it cannot be the primary cause, because the architecture never
*asked* in 9/10 runs.

**Explicitly not causes:** TOOL_AVAILABILITY (bash exposed and demonstrably usable),
PROMPT_DESIGN (imperative and task-specific), BENCHMARK_ARTIFACT (the fixture has no test script,
but the prompt's fallback — `node --check`, curl the endpoint — remained fully available, and the
validator drives the modules directly).

# 10. Severity

**High for trustworthiness; low for correctness.**

- No incorrect edits and no data loss. Both guard checks passed in every run.
- **Kodo's central design claim is that it verifies its own work.** In 10 runs it produced valid
  self-verification evidence **zero times**, and the one "passed" verification was against a test
  script the agent had authored itself.
- The failure is silent: a user reading `finalAnswer` sees either a false "stopped early" or, in
  f-fs-5, an unsupported success claim.
- It degrades every downstream honesty metric, since `verificationSuccessRate` is computed from
  events that mostly never occur.

# 11. Proposed Fixes

*Not implemented. Presented smallest-first.*

### Fix A — consult the finish gate before converting a no-progress streak into a stop
- **File:** `backend1/services/taskController.mjs` (`endIteration`, ~:1438)
- **Mechanism:** when the streak trips and the task has mutations but no verification, issue the
  existing `canFinish()` verification directive **once** (as a `directiveKind`, exactly like the
  existing `discovery_grace` reprieve at :1452) instead of stopping outright. Reuse
  `MAX_VERIFY_PUSHBACKS` so it cannot loop.
- **Expected:** the agent is told to run a real check at the moment it goes idle after editing.
- **Risk:** low — mirrors a proven pattern already in the file; bounded; a model that ignores the
  directive still stops on the next streak.
- **Test:** drive the controller with edits-then-repeated-reads; assert a verification directive is
  emitted before any `no_progress` stop.
- **Fairness:** neutral — no task, command, or filename is named.

### Fix B — let a verification *attempt* score progress in IMPLEMENTATION
- **File:** `backend1/services/taskController.mjs` (`assessProgress`, :1213)
- **Mechanism:** `firstVerification` currently requires `mark.verifications === 0`; re-reading
  project config as part of VERIFY scores nothing. Credit the first read of a project manifest after
  mutations as progress.
- **Expected:** removes the penalty for starting the VERIFY step.
- **Risk:** medium — widens the progress definition and could weaken loop detection guarded by
  `tests/taskController.test.mjs:480`.
- **Fairness:** neutral. **Weaker than A** — treats a symptom.

### Fix C — derive phase from completion signals, not `state` alone
- **File:** `backend1/services/taskController.mjs` (`currentPhase`, :1262)
- **Mechanism:** when mutations satisfy `minMutatedFiles` and no todos/unmet remain, report
  VERIFICATION even if `state === "patch"`.
- **Expected:** breaks the circular dependency in §4.
- **Risk:** **high** — `currentPhase()` feeds many rules; changing it has wide blast radius.
- **Fairness:** neutral. Not recommended without broader work.

# 12. Recommended Fix

**Fix A**, alone. It is the smallest change that puts the *existing, already-correct* verification
directive onto the path these runs actually take, reuses an established bounded-reprieve pattern,
introduces no new state, and leaves loop detection untouched. Fixes B and C both widen definitions
that other guarantees depend on.

Fix A also subsumes much of the separately-investigated `no_progress` misreport: a run that is
directed to verify, does so, and then finishes will exit through `canFinish()` rather than
`blockerReport()`. The two issues share this root and should be scheduled together — but the
classification fix from the previous investigation is still needed for runs where the agent declines
the directive.

# 13. Benchmark Fairness Impact

None of the proposed fixes name this benchmark, its task, its route, its filenames, or any specific
command. All operate on generic signals already tracked for every task (mutation counts, todo state,
verification events).

**Scoring is unaffected either way**: the validator reads the workspace, never the agent's report
(`benchmarks/README.md`: "Never credit a self-report"). All five qwen runs scored `pass` while
claiming failure, which is the harness behaving correctly.

One fairness caveat worth stating: Fix A would likely *increase* Kodo's token cost per task (an
extra directive turn plus the verification command). Cross-agent cost comparisons made before and
after would not be directly comparable, and the earlier gpt-4.1-nano vs Claude Code numbers should
not be diffed against post-fix runs.

# 14. Production Files Modified

**NONE.** Verified: `agent_loop.mjs`, `taskController.mjs`, `syntax.util.mjs`, the validator, the
fixtures and the task are byte-identical to their pre-investigation state. The only artifacts
created are this report and a read-only diagnostic script in the session scratchpad.
