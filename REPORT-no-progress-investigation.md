# Kodo `no_progress` False-Classification Investigation

Investigation only. **No production file was modified.** The diagnostic harness lives outside the
repo, in the session scratchpad, and imports the unmodified controller.

# 1. Finding

**This is a real defect, and it is Outcome B: the task was complete, and the controller
misclassified the final state as `no_progress`.**

The controller's termination policy answers *"did the last few turns change anything?"* It never
asks *"is the work already done?"* — even though, at the moment it fires, it is holding four
independent signals saying the work **is** done. A correct, complete, validator-verified
implementation is therefore reported to the user as:

> **Stopped early — `no_progress`.** I did not finish this task.

The `no_progress` **stop** is defensible (the agent really was making no further progress — it was
idling). The **report** is false: it asserts the task was not finished, when it was.

# 2. Exact Code Path

Owner: **Kodo's controller** (`backend1/services/taskController.mjs`). Not the benchmark harness —
`bench/` only reads `stopReason` out of `runMetrics.controller`.

```
recordToolCall(read_file)                     taskController.mjs:906
   └─ read_file is not a mutation → mutations/editedPaths unchanged
endIteration()                                taskController.mjs:1319
   └─ assessProgress()                        taskController.mjs:1199
        learnedSomething   = inspectedPaths.size > mark.inspected   → FALSE (re-read, already counted)
        editedSomethingNew = editedPaths.size  > mark.edited        → FALSE
        firstVerification  = …                                      → FALSE (no verification ran)
        diagnosticsMoved / planAdvanced / unblocked                 → FALSE
        phase = currentPhase() = "IMPLEMENTATION"   (state === "patch")
        └─ IMPLEMENTATION branch (line 1245-1251):
             only `learnedSomething` can score — reading a file already read scores nothing
        → progressed = false
   └─ noProgressStreak++                      taskController.mjs:1335
   └─ noProgressStreak >= maxNoProgress (3)   taskController.mjs:1438
        └─ DISCOVERY grace not applicable (phase is IMPLEMENTATION)
        └─ stop(STOP_REASONS.NO_PROGRESS, …)  taskController.mjs:1485
   └─ blockerReport()                         taskController.mjs:1497
        → "**Stopped early — `no_progress`.** I did not finish this task."
```

The decisive line is the `else` branch at **taskController.mjs:1245-1251**: in
IMPLEMENTATION/VERIFICATION, re-reading a file already inspected earns no credit. That rule is
correct in isolation — it is what stops an agent looping on the same file forever. The bug is that
**nothing upstream of it checks whether the task is complete before converting the streak into
"I did not finish".**

# 3. Evidence From Qwen Runs

Both runs below were scored **8/8 PASS** by the validator.

### q-fs-1 — real trace (14 tool calls)

```
 1. todo_write
 2. read_file  client/App.mjs
 3. read_file  server/api.mjs
 4. read_file  client/apiClient.mjs
 5. edit_file  server/api.mjs
 6. todo_write
 7. edit_file  client/apiClient.mjs
 8. todo_write
 9. edit_file  client/App.mjs
10. edit_file  client/App.mjs
11. todo_write
12. read_file  client/App.mjs        ← re-read of call 2
13. read_file  server/api.mjs        ← re-read of call 3
14. read_file  client/apiClient.mjs  ← re-read of call 4
```

Calls 12-14 re-read exactly the files from 2-4 — a self-review of its own edits. `inspectedPaths`
already contained all three, so `learnedSomething` was false on every one.

### Replay through the unmodified controller

```
turn | tool        path                  | progressed | streak | phase          | reasons
   1 | todo_write                        | true       |      0 | PLANNING       | revised the plan
   2 | read_file   client/App.mjs        | true       |      0 | PLANNING       | gathered new information
   3 | read_file   server/api.mjs        | true       |      0 | PLANNING       | gathered new information
   4 | read_file   client/apiClient.mjs  | true       |      0 | PLANNING       | gathered new information
   5 | edit_file   server/api.mjs        | true       |      0 | IMPLEMENTATION | edited a new file
   6 | todo_write                        | false      |      1 | IMPLEMENTATION |
   7 | edit_file   client/apiClient.mjs  | true       |      0 | IMPLEMENTATION | edited a new file
   8 | todo_write                        | false      |      1 | IMPLEMENTATION |
   9 | edit_file   client/App.mjs        | true       |      0 | IMPLEMENTATION | edited a new file
  10 | edit_file   client/App.mjs        | false      |      1 | IMPLEMENTATION |   ← 2nd edit to same file
  11 | todo_write                        | false      |      2 | IMPLEMENTATION |
  12 | read_file   client/App.mjs        | false      |      3 | IMPLEMENTATION |   ← STOP
→ STOPPED: no_progress
→ "3 consecutive steps changed nothing — no new files, no new edits, no change in diagnostics."
```

### q-fs-3 — same transition, one turn later

```
  10 | edit_file   client/App.mjs        | true       |      0 | IMPLEMENTATION | edited a new file
  11 | edit_file   client/App.mjs        | false      |      1 | IMPLEMENTATION |
  12 | read_file   client/App.mjs        | false      |      2 | IMPLEMENTATION |
  13 | read_file   server/api.mjs        | false      |      3 | IMPLEMENTATION |   ← STOP
→ STOPPED: no_progress
```

**Fidelity caveat, stated plainly:** the replay drives `endIteration()` once per *tool call*, while
production drives it once per *LLM turn* (which may batch several tool calls). So the turn indices
above run ahead of production's recorded `iterations: 9` / `11`. The replay is faithful on the thing
being investigated — it reaches `noProgressStreak: 3` in phase IMPLEMENTATION and emits the
identical `no_progress` reason and detail string, matching the `noProgressStreak: 3` recorded in
both production runs. It is not a cycle-accurate reproduction of turn numbering.

Note also that the streak is not built purely from the self-review reads: `todo_write` calls and a
second edit to an already-edited file are also scored as non-progress, so the streak is typically at
1-2 before the reads begin.

# 4. Controller State

Recorded in `summary.json` at the moment of the stop (identical in both runs):

| Field | q-fs-1 | q-fs-3 |
| --- | --- | --- |
| `stopReason` | `no_progress` | `no_progress` |
| `noProgressStreak` | **3** (= `maxNoProgress`) | **3** |
| `phase` / `state` | IMPLEMENTATION / `patch` | IMPLEMENTATION / `patch` |
| `mutations` | 4 | 4 |
| `integrationEdits` | 4 | 4 |
| `minMutatedFiles` (budget) | 2 | 2 |
| `openTodos` | **[]** | **[]** |
| `planItemCount` | 3 | 3 |
| `unmet` | **[]** | **[]** |
| `incompleteOnFinish` | **false** | **false** |
| `verifications` | **[]** | **[]** |

**Four completion signals were true at the instant the controller declared the task unfinished:**

```
mutations (4) >= minMutatedFiles (2)  : true
openTodos empty                       : true
unmet requirements empty              : true
every named file was edited           : true
```

`state` never advanced past `patch` → `verify`, because `enter("verify")` is reached only by a
verification event, and no verification ran. That is what pins `phase` to IMPLEMENTATION and puts
the run on the strict branch.

# 5. Why Verification Did/Did Not Matter

Verification **did** matter, as an enabling condition, but it is not the root cause.

- `verifications: []` — the agent ran zero `bash` commands in all five runs. It "verified" by
  re-reading its edits, which the controller does not recognise as verification.
- Consequently `firstVerification` and `passed && !mark.passed` could never fire, removing two of
  the six ways to score progress.
- Consequently `state` stayed `patch`, so `phase` stayed IMPLEMENTATION, where reading earns nothing.

Had the agent run one real check, it would have scored "ran verification", reset the streak, and
moved to `verify`. So a verifying agent would not hit this. **But the misreport does not require the
absence of verification** — any agent that finishes its edits and then spends three turns not
mutating (self-review, `todo_write` bookkeeping, a redundant edit) lands in the same place. The
completion signals are ignored either way.

# 6. Is This a Real Kodo Defect?

**YES — case B**, on the §"Important Distinction" criteria.

- Case A (agent genuinely stopped before completion) is **excluded**: the validator independently
  scored 8/8 including the end-to-end integration check, all three layers were correctly modified,
  and the controller's own `openTodos`/`unmet`/`incompleteOnFinish` all said complete.
- Case B is **established**: the work was finished and the controller reported it as unfinished.

Precise scope of the defect — this distinction matters for the fix:

- **Stopping is correct.** The agent was idling; ending the run saved budget.
- **The classification and report are wrong.** `no_progress` and *"I did not finish this task"* are
  false statements about a completed task.

So this is a **reporting/classification defect, not a termination defect.**

# 7. Severity

**Medium — high for evaluation, low for end users' workspaces.**

- No data loss, no incorrect edits, no safety impact. The workspace is correct in every case.
- It is an **honesty defect in the safe direction**: Kodo under-claims. Far better than the
  false-positive direction, and consistent with the design principle that a run must never report
  success it cannot support.
- **It systematically understates Kodo.** 5/5 genuinely passing runs self-reported as failures. Any
  consumer trusting `finalAnswer` over the validator — a user, a CI gate, or an agent comparison —
  would read a perfect score as a total failure.
- It cost real analysis time in this very benchmark: it was initially flagged as a curiosity in the
  qwen model-swap report before being traced here.

# 8. Minimal Fix Proposal

*Not implemented, per the strict rule.*

**Smallest change that corrects the classification without altering agent behaviour:** keep the stop
exactly as it is, and gate only the *reason and report* on the completion signals the controller
already computes.

At `taskController.mjs:1438`, before `stop(STOP_REASONS.NO_PROGRESS, …)`, when **all** of the
following already-tracked conditions hold:

- `requiresMutation && mutations >= minMutatedFiles`
- `openTodos.length === 0`
- `unmet.length === 0`

…stop with a distinct terminal reason (e.g. `STOP_REASONS.SETTLED` / `"idle_after_completion"`)
whose `blockerReport()` states that the work appears complete and unverified, rather than asserting
*"I did not finish this task."*

Properties: no new state is introduced (all four fields already exist and are already serialised
into `runMetrics.controller`); the agent still stops on the same turn, so token cost and behaviour
are unchanged; only the label and prose differ. `bench/scoring.mjs` treats
`EARLY_STOP_REASONS = ["blocked","no_progress","thrashing","budget_exhausted"]` as early stops, so a
new reason outside that set would additionally stop these runs being counted as `stopped_early` —
which is the correct outcome and should be a deliberate part of the change, not a side effect.

**Explicitly rejected alternatives:** crediting re-reads as progress (would break the
`no_progress` loop detection that `tests/taskController.test.mjs:480` guards); raising
`maxNoProgress` (delays the stop, does not fix the false report); treating self-review reads as
verification (would manufacture verification evidence that does not exist — the opposite of the
verification-integrity work already done).

# 9. Benchmark Impact

**None on scoring — the benchmark was never fooled.** Validation reads the workspace, not the
agent's self-report, exactly as `benchmarks/README.md` requires ("never credit a self-report").
All five qwen runs were correctly scored `pass` / 1.00 despite claiming failure.

Two secondary effects are real:

1. `metrics.stoppedEarly: true` and `controller.stopReason: "no_progress"` are recorded on 5/5
   passing runs, so any analysis keying on those fields will misread them.
2. `bench compare-agents` reports per-capability rates derived from these fields, so a
   cross-agent comparison would penalise Kodo for stopping early on tasks it actually completed.

The inverse — a *false* self-reported success — is what the harness is built to catch, and that
protection is unaffected.

# 10. Recommendation

1. **Fix the classification, not the termination.** The stop is correct; only the label and prose
   are wrong. Resist widening the progress rules.
2. **Add a regression test** asserting that a run which satisfies `minMutatedFiles`, has no open
   todos and no unmet requirements does **not** report `no_progress` / "I did not finish this task".
3. **Separately, investigate why the agent never verifies.** Across 10 runs (nano and qwen) not one
   ran a real check after completing its edits. That is the upstream condition that put these runs
   on the strict branch, and it is a larger quality issue than the misreport — a genuinely verifying
   agent would both avoid this bug and produce trustworthy completions.
4. Re-run the 5-run qwen benchmark after any fix to confirm the reports match the validator.
