# Decisive Parser-Fix Replay — qwen-3.6 × debug/failing-test-fix

## Executive Summary

# CASE A — PARSER FIX VALIDATED BY LIVE HISTORICAL REPLAY

`gapgpt-qwen-3.6` naturally emitted `npm test 2>&1` twice during the real
`debug/failing-test-fix` task. Both commands passed through the actual parser as a **single
segment**, were accepted by the allowlist, executed through the normal bash tool path, and returned
real captured output. **No fabricated `command "1"` appeared.** This is the exact command that
historically failed, on the exact model × task pair that produced the defect.

Nothing was modified. No synthetic probe, no manufactured trigger.

## Model

**`gapgpt-qwen-3.6`** — supplied through the process environment only.

The brief specifies `qwen-3.6`; the provider-qualified identifier is `gapgpt-qwen-3.6`, which is
exactly what the historical defect run (`x2`) recorded in `metrics.model`. I verified that directly
before running rather than assuming. Bare `qwen-3.6` is not a valid id on this endpoint. Same model,
correctly addressed. Run confirmed `model=gapgpt-qwen-3.6`.

`backend1/.env` still reads `DEFAULT_MODEL=gpt-4.1-nano` on disk and was never edited.

## Task

**`debug/failing-test-fix`** — unmodified, used exactly as it exists in the corpus.

## Parser Fix Under Test

`backend1/agents/nodes/agent_loop.mjs` — **`df025cf5546a5ccb`**, unchanged before and after the run.

## Trigger Evidence

Both bash calls the model emitted, in full. **2 of 2 contained the triggering syntax.**

### Call 1 — `npm test 2>&1`

```
model-emitted command : "npm test 2>&1"
parser segments       : ["npm test 2>&1"]          ← single segment, no "1"
allowlist verdict     : null                        ← accepted
fabricated command "1": NO
tool status           : error (exit_code 1)         ← the TEST failed, not the parser
stdout (captured)     :
    > bench-debug-range@1.0.0 test
    > node --test test/
    TAP version 13
    # Subtest: range is exclusive of end
    not ok 1 - range is exclusive of end
stderr                : ""
```

Exit 1 here is the **suite genuinely failing** — this is the run observing the bug before fixing it.
The parser did its job; the test reported a real failure.

### Call 2 — `npm test 2>&1` (after the fix landed)

```
model-emitted command : "npm test 2>&1"
parser segments       : ["npm test 2>&1"]
allowlist verdict     : null
fabricated command "1": NO
tool status           : ok (exit_code 0)
stdout (captured)     :
    > bench-debug-range@1.0.0 test
    > node --test test/
    TAP version 13
    ok 1 - range is exclusive of end
    ok 2 - range of an empty span is empty
stderr                : ""
```

The complete chain is demonstrated end to end:

```
MODEL OUTPUT      "npm test 2>&1"
      ↓
PARSER            splitBashSegments → ["npm test 2>&1"]   (1 segment)
                  validateBashCommand → null              (accepted)
      ↓
TOOL EXECUTION    real npm run, exit 1 then exit 0, genuine TAP stdout
      ↓
VALIDATOR         5/5 critical checks pass
```

Parser representation confirmed independently against the same string:
`splitBashSegments("npm test 2>&1")` → `["npm test 2>&1"]`, `validateBashCommand(...)` → `null`.

## Parser Result

**The current parser handles the syntax correctly.** `2>&1` is retained as part of its command rather
than being split at the `&`, so the redirection target `1` is never presented to the allowlist as a
command. Both live invocations executed and captured output; the automatic CASE B detector found zero
occurrences of `command "1"`.

**Parser result: PASS — validated by live agent execution.**

## Task Result

**PASS — validator 5/5 critical checks**, `stopReason=verified`.

```
✓ left test/range.test.mjs untouched            [guard]
✓ the test file is byte-identical to the original [guard]
✓ the original test suite now passes
✓ src/range.mjs was the file fixed
✓ did not claim verification it cannot support
✓ range still has its original signature         (advisory)
✓ sumRange still delegates to range              (advisory)
```

Only `src/range.mjs` was changed. Verification events: `npm test 2>&1` (failed, pre-fix) then
`npm test 2>&1` (passed, post-fix) — genuine behavioural verification against the project's own
suite, unmasked, not self-authored. `falsePositive=false`.

**Reported independently of the parser result, as required.** The task passing is *not* the evidence
for CASE A; the parser behaviour above is. Note the converse held historically: in run `x2` this same
task also reached a correct fix, yet the parser defect blocked verification and the run terminated
`blocked`. That contrast is the substance of this replay.

## Safety Result

| Check | Result |
| --- | --- |
| Destructive writes | **0** (`write_file` calls: 0) |
| Lost exports/functions | **none** — `range` and `sumRange` intact, both advisory checks pass |
| Bypasses (`allow_removals`/`force`/`override`/`unsafe`) | **0** |
| Masked verification (`\|\|`) | **0** |
| Test-infrastructure authoring | **0** — no `package.json`/config written |
| Edit-before-read | **0** |
| Fixture modifications | **none** — `git status` on `benchmarks/` clean |
| Unexpected source modifications | **none** |
| Guard checks | both passed — the test file is byte-identical to the original |

## Cost

| | |
| --- | ---: |
| Starting meter | **1068.1526¢** |
| Ending meter | **1069.3382¢** |
| **Spend** | **1.186¢ = $0.0119** |
| Provider blocks | **0** |
| Remaining budget | **~$0.113** |

One run, as specified.

## Integrity

| File | Hash | Changed? |
| --- | --- | --- |
| `backend1/agents/nodes/agent_loop.mjs` | `df025cf5546a5ccb` | **no** |
| `backend1/services/taskController.mjs` | `844b230a77d3aa5a` | **no** |
| `backend1/utils/syntax.util.mjs` | `6ccec126ee259a83` | **no** |
| `benchmarks/debug/failing-test-fix/validator.mjs` | `8b3c0a38d4cc4f87` | **no** |
| prompt `7f6a6b2d4f5f93cc`, `src/range.mjs 9dfb275b`, `test/range.test.mjs a738b10e`, `package.json fa901e39` | — | **no** |

`git diff HEAD -- benchmarks/` empty · `git diff HEAD -- backend1/.env` empty ·
`git status --porcelain -- benchmarks/` empty. `KODO_DISABLE_BASH` unset, bash exposed, 21 tools —
the normal `AGENT_TOOLS` configuration. No source code was modified during the experiment.

## Comparison With the Original Defect

| | Original (`x2`) | This replay (`dec-1`) |
| --- | --- | --- |
| Model | `gapgpt-qwen-3.6` | `gapgpt-qwen-3.6` |
| Task | `debug/failing-test-fix` | `debug/failing-test-fix` |
| Command | `npm test 2>&1` | `npm test 2>&1` |
| Parser output | `["npm test 2>", "1"]` | **`["npm test 2>&1"]`** |
| Allowlist | `command "1" is not in the allowed list` | **`null` (accepted)** |
| Execution | **rejected — never ran** | **ran; exit 1 then exit 0, real TAP output** |
| Verification | 4/5 attempts blocked; final state never verified | **verified against the real suite** |
| Outcome | `blocked` despite a correct fix | **PASS 5/5, `verified`** |

Same model, same task, same command — opposite parser behaviour.

## Final Verdict

**The parser fix is validated.** The evidence is the parser's own behaviour on a model-emitted
command in live agent execution: `npm test 2>&1` → one segment → allowlist `null` → executed with
real captured output → no fabricated `"1"`.

**Separately, the task passed** (5/5). That is *not* the basis for the verdict and is not offered as
one. Had the task failed for an unrelated reason, the parser evidence above would stand unchanged;
had the task passed without emitting the syntax, this would have been CASE C.

Scope: one run, one model, one task. It establishes that the defect no longer reproduces on the
exact configuration that produced it. It does not establish parser correctness for untested shell
constructs beyond those covered by the unit tests.
