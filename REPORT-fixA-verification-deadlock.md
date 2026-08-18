# Fix A — Verification Deadlock

Date: 2026-08-15 · Commit `870a170` · Benchmark **not run** in this phase.

# 1. Root Cause

Kodo's verification obligation is enforced only by `canFinish()`, which is reached only when the
model emits a turn with **no tool calls** (`agent_loop.mjs:3554`). The no-progress stop path
(`agent_loop.mjs:3690-3697`) does `verdict.stop → break` and never consults that gate.

Meanwhile the agent's own instructions (system prompt step 4, VERIFY) tell it to *"read the
sub-project you touched (its package.json / project config)"* and *"Re-read the edited region too"*
**before** running the check. `assessProgress()` credits a re-read of an already-inspected file as
**zero** during IMPLEMENTATION (`taskController.mjs:1245-1251`) — correctly, since that is what
catches a read loop.

So an agent following the documented procedure builds a no-progress streak **by complying**, and was
killed at the threshold, frequently before reaching the `bash` call the step exists to produce. The
stop bypassed `canFinish()`, so the mandatory verification directive was never issued: the run ended
unverified **without ever having been asked to verify**.

The phase logic compounds it. `currentPhase()` derives from `state`, and `state` leaves `patch` only
on a verification event — so verification is required to leave IMPLEMENTATION, and IMPLEMENTATION is
the phase that terminates you for starting verification.

# 2. Exact Previous Control Flow

```
edits land               → state = patch, phase = IMPLEMENTATION
agent begins VERIFY      → re-reads edited files + package.json
assessProgress()         → learnedSomething = false (already inspected)
                         → progressed = false
noProgressStreak++ ×3    → >= maxNoProgress (3)
  ├─ phase === DISCOVERY ? no  → discovery_grace not applicable
  └─ stop(NO_PROGRESS)                                    taskController.mjs:1438
agent_loop: verdict.stop → finalAnswer = blockerReport(); break;   agent_loop.mjs:3696
                         → canFinish() NEVER CALLED
                         → verification directive NEVER ISSUED
```

# 3. Fix A Implementation

A second one-shot reprieve, placed immediately after the existing `discovery_grace` reprieve and
before the unchanged `no_progress` stop. It mirrors that proven pattern exactly.

```js
if (requiresMutation && !verificationGraceUsed && !verificationRan()
    && mutations >= minMutatedFiles && editedPaths.size > 0) {
  verificationGraceUsed = true;
  noProgressStreak = 0;
  return {
    ...base,
    noProgressStreak: 0,
    directiveKind: "verification_grace",
    directive: unverifiedDirective([...editedPaths]),
  };
}
```

**The existing verification machinery is reused, not duplicated.** The directive text was extracted
verbatim from `canFinish()` into `unverifiedDirective(edited)` and both call sites now share it, so
the two paths cannot drift into two subtly different verification policies.

**The reprieve asks for verification; it never supplies it.** `verificationRan()` is still satisfied
only by a real event recorded through `recordToolCall`/`recordVerification`, and every
evidence-quality rule — masked `||` commands, vacuous test runs, missing scripts, test-infrastructure
self-authoring — applies unchanged. Test 8 asserts this directly.

# 4. Files Changed

| File | Change | Lines |
| --- | --- | --- |
| `backend1/services/taskController.mjs` | `verificationGraceUsed` flag; `unverifiedDirective()` extracted from `canFinish()`; the reprieve block; snapshot field | ~40 |
| `backend1/agents/nodes/agent_loop.mjs` | one `NUDGE` entry for `verification_grace` — without it the generic fallback would announce *"time to implement"* at the moment the work is finished and being checked | 3 |
| `backend1/tests/verificationGrace.test.mjs` | new, 8 tests | new file |

Hashes: `taskController.mjs 95ca2ba5… → 844b230a…`, `agent_loop.mjs 9f004c74… → 3adb0306…`.
`syntax.util.mjs` **unchanged** (`6ccec126…`, byte-identical). No other production file touched.

Explicitly **not** implemented in this change: the `idle_after_completion` classification fix from
the previous investigation.

# 5. Why The Fix Is Bounded

Four independent bounds:

1. **One-shot per run.** `verificationGraceUsed` is set on the first grant and never cleared.
2. **Requires real work.** Gated on `requiresMutation && mutations >= minMutatedFiles &&
   editedPaths.size > 0` — an exploring-only task is untouched.
3. **Self-extinguishing.** It fires only while `!verificationRan()`. Once the agent verifies, the
   condition can never hold again.
4. **The stop is unchanged.** If the directive is ignored, the streak rebuilds and the next trip
   lands on the identical `stop(NO_PROGRESS)` with the identical detail string.

The `no_progress → directive → no_progress → directive → …` cycle is therefore impossible. Test 3
drives 40 consecutive non-verifying turns and asserts the reprieve is granted **exactly once** and
the run still terminates.

# 6. Regression Tests

`backend1/tests/verificationGrace.test.mjs` — **8/8 pass**.

| # | Test | Result |
| --- | --- | --- |
| 1 | Completed implementation stalling mid-VERIFY gets one reprieve | ✅ |
| 2 | After the reprieve, a real verification event is credited and `canFinish()` allows completion | ✅ |
| 3 | Directive ignored → reprieve consumed once, run still stops, no infinite loop (40 turns) | ✅ |
| 4 | No meaningful mutations → existing `no_progress` behaviour unchanged | ✅ |
| 5 | Verification already exists → no reprieve issued | ✅ |
| 6 | Repeated stalls after the reprieve → no second reprieve | ✅ |
| 7 | `discovery_grace` unchanged, and does not consume the verification reprieve | ✅ |
| 8 | The reprieve is not verification: `canFinish()` still blocks, masked commands still rejected | ✅ |

**Pre-fix behaviour**, verified by stashing `taskController.mjs`: all 8 fail. Being precise about
why, because it is not uniform — tests **1, 2, 3, 6, 8** fail on the reprieve behaviour itself
(no directive is ever issued). Tests **4, 5, 7** fail only because `snapshot().verificationGraceUsed`
is `undefined` rather than `false`; their behavioural assertions (discovery_grace fires,
`no_progress` still stops an exploring task) hold in both versions. So the honest count is **5 tests
that detect the defect**, and 3 that guard against regressions in surrounding behaviour.

A test-authoring note worth recording: my first draft of the helper only *edited* the three files
without reading them first, so every later read counted as a new inspection and no streak ever built
— the tests failed against a working fix. Corrected to mirror the real trace (read all three, then
edit all three, then re-read), which is what makes the re-reads score zero.

# 7. Existing Test Suite

| Scope | Result |
| --- | --- |
| Targeted (`taskController`, `taskShape`, `agentBenchmark`, `rewriteSafety`, `editSafety`, `verificationGrace`) | **30/30 pass** |
| Full suite `node --test tests/` | **70 passed / 5 failed of 75** |

| Classification | Tests |
| --- | --- |
| **INTRODUCED BY FIX A** | **none** |
| **PRE-EXISTING** | `benchmarkFixtures`, `benchmarkMetrics` (fail with all fixes stashed); `mcpLiveE2E`, `subagentLiveE2E` (require unset `KODO_E2E_API_KEY`) |
| **FLAKY** | `configWatcher` — passes in isolation (1/1); matches the established pattern where `sandboxEscape`/`hooks`/`sessionHooks` fail in varying combinations under parallel load |

Test count rose 67 → 75 from the new file. Critically, `taskController.test.mjs` — which contains the
existing `no_progress` guarantees including *"re-reading the same file with no new information is
no_progress"* (:480) — passes unchanged.

# 8. Safety Impact

**None weakened.** Verified by the targeted suite and by test 8 specifically:

- edit safety, write safety, `.mjs` syntax validation, export preservation — `syntax.util.mjs` is
  byte-identical and `rewriteSafety`/`editSafety` pass 19/19.
- masked-command detection, vacuous-run detection, missing-script detection,
  test-infrastructure self-authoring detection — all untouched; test 8 confirms a `||`-masked
  command still fails to certify **after** the reprieve.
- A verification *directive* does not equal verification *success*: `canFinish()` still returns
  `allowed: false, kind: "unverified"` for a run that received the reprieve and did nothing.

# 9. Benchmark Impact

**FULL BENCHMARK NOT RUN YET.** No claim is made about benchmark outcomes.

What the tests establish is narrow and specific: after the reprieve, a real verification event *can*
be recorded and *does* unblock completion (test 2). They do **not** establish that a live model will
respond to the directive by running a command — only a benchmark run can show that, and the
secondary cause identified earlier (qwen invoked bash zero times in 5 runs) is a real reason it might
not.

Expect a cost increase per task if the fix works as intended: at least one extra directive turn plus
the verification command itself. Pre-fix and post-fix cost figures will not be directly comparable.

# 10. Remaining Known Issues

1. **The `no_progress` misreport is unfixed** — deliberately out of scope here. A run that receives
   the reprieve and still declines to verify will stop with `no_progress` and report *"I did not
   finish this task"*, which remains false for a completed-but-unverified task.
2. **Model behaviour is unaddressed.** Fix A makes the request; it cannot make the model comply.
3. **Only the no-progress path is covered.** Other early stops (`thrashing`, `budget_exhausted`)
   still bypass `canFinish()` and issue no verification directive. Not observed in any run so far, so
   not addressed.
4. `configWatcher` and the other load-sensitive suites remain flaky under parallel execution —
   pre-existing and unrelated.
