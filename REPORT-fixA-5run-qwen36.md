# Fix A Validation — 5 Runs, Kodo + gapgpt-qwen-3.6

# 1. Experimental Objective

Determine whether Fix A (`verification_grace`) resolves the verification deadlock: does the reprieve
fire in live runs, and does the model answer it with **genuine** verification before Kodo terminates?

The PASS rate is explicitly **not** the headline metric — qwen was already 5/5 before Fix A.

# 2. Frozen-State Hashes

| File | SHA256 (16) | vs previous qwen run |
| --- | --- | --- |
| `backend1/services/taskController.mjs` | `844b230a77d3aa5a` | **changed — Fix A (intended)** |
| `backend1/agents/nodes/agent_loop.mjs` | `3adb0306e59b56da` | **changed — Fix A (intended)** |
| `backend1/utils/syntax.util.mjs` | `6ccec126ee259a83` | identical |
| `benchmarks/…/validator.mjs` | `a42a52f556257c23` | identical |
| `benchmarks/…/prompt.md` | `9f878545749028b6` | identical |
| fixture `server/api.mjs` | `4d7ac0b201ff4e78` | identical |
| fixture `client/apiClient.mjs` | `529c50fdb617b2f4` | identical |
| fixture `client/App.mjs` | `7756678afad9ce31` | identical |

`git diff HEAD -- benchmarks/` empty. HEAD `870a170`. The controlled delta is exactly Fix A.

# 3. Model / Provider Configuration

`DEFAULT_MODEL=gapgpt-qwen-3.6` exported into the run environment only; `backend1/.env` still reads
`DEFAULT_MODEL=gpt-4.1-nano` on disk and the shell variable was unset before launch. Provider, base
URL and key unchanged. Every run independently recorded `model=gapgpt-qwen-3.6`.

Pre-flight: model responded HTTP 200 in 3.53s; a real tool call was emitted
(`bash {"command":"ls -la"}`) in 1.30s — so a low bash rate could not be blamed on the provider.

# 4-5. Valid Runs / Provider-Blocked

**5 valid runs from 5 attempts. 0 provider-blocked.** (Cap was 12.)

# 6-11. Per-Run Results

| Run | Outcome | Validator | Route | Grace fired | Bash | Verification events | stopReason | Phase | False verif. | Cost |
|---|---|---|---|---|---:|---:|---|---|---|---:|
| a-fs-1 | PASS | 8/8 | PASS | ✅ once | 5 | 3 (all passed) | `verified` | VERIFICATION | no | ~$0.056 |
| a-fs-2 | PASS | 8/8 | PASS | ✅ once | 12 | 2 (1 passed) | *(none — normal finish)* | VERIFICATION | no | ~$0.133 |
| a-fs-3 | PASS | 8/8 | PASS | ✅ once | 8 | 6 (5 passed) | `verified` | VERIFICATION | no | ~$0.080 |
| a-fs-4 | PASS | 8/8 | PASS | ✅ once | **0** | **0** | `no_progress` | IMPLEMENTATION | no | ~$0.040 |
| a-fs-5 | PASS | 8/8 | PASS | ✅ once | 7 | 2 (both passed) | `verified` | VERIFICATION | no | ~$0.090 |

Backend, client API, client UI and integration passed in **5/5** (all 8 critical checks each run).

**Outcome classification (per the brief's A/B/C/D):**
- **Outcome C** (grace → real verification → completion): **4/5** — a-fs-1, 2, 3, 5
- **Outcome D** (grace fired, model ignored it, normal termination): **1/5** — a-fs-4
- Outcome A (false success claim): **0/5**
- Outcome B: 0/5

# 14. Evidence That `verification_grace` Actually Fired

`verificationGraceUsed = true` in **5/5** runs, recorded in `metrics.controller` — including a-fs-4,
where the model then ignored it. Exactly once per run, as designed.

# 15. Evidence That Real Verification Occurred

Verification events recorded in **4/5** runs, 13 events total. Representative commands, taken
verbatim from `metrics.controller.verifications`:

```
node --check server/api.mjs && echo "server/api.mjs OK" && node --check client/apiClient.mjs && …
node --check client/App.mjs
node .kodo/scratch/verify.mjs
```

The behavioural scripts import the **real** modules and exercise the actual endpoint. a-fs-3's
`.kodo/scratch/verify.mjs`:

```js
import { handle, USERS } from '../../server/api.mjs';
const r1 = handle('GET', '/api/users/u1');   // → {"status":200,"body":{"name":"Ada Lovelace",…}}
const r3 = handle('GET', '/api/users/missing'); // → {"status":404,"body":{"error":"not found"}}
const r4 = handle('GET', '/api/users');         // → 200, 2 users
```

Real output, exit 0 — the same technique the validator itself uses.

**Two honest limitations on this evidence:**

1. **`node --check` is parse-only.** It proves the files compile, not that the route works. It is
   genuine verification but weak, and it is the *only* verification in a-fs-5.
2. **Most behavioural scripts print rather than assert.** a-fs-3's script `console.log`s its results
   and would exit 0 even if the values were wrong; the *model* read the output and judged it. So the
   exit code the controller credits proves the script ran, not that the assertions held. Only
   a-fs-2's script computed an explicit `ok1 && ok2 && …` PASS/FAIL. This is materially weaker than
   a suite that fails loudly, and I am not counting it as equivalent.

# 16. False Verification

**0/5.** `falsePositive=false` in every run. No masked commands (`||`) were issued at all — 0 across
32 bash calls. No `package.json`, `tsconfig` or config file was written or edited in any run. The
f-fs-5 pattern (authoring a test script until `npm test` exits 0) did not recur.

The scratch scripts are **not** manufactured test infrastructure: they modify no manifest, exercise
the real modules, and were deleted afterward — the final changed set is exactly the three target
files in all five runs.

# 17. `no_progress` Termination

**1/5** (a-fs-4), down from **5/5** before Fix A. In that run the reprieve fired, the model issued no
bash call, the streak rebuilt, and the unchanged `no_progress` stop terminated the run — the bounded
behaviour Fix A was designed to preserve. It also reproduced the known misreport: a-fs-4 scored 8/8
PASS while reporting *"Stopped early — no_progress. I did not finish this task."* That defect is
still open and deliberately out of scope.

# 18-19. Safety / New Failures

| Metric | Result |
| --- | --- |
| edit-before-read | **0** across all runs |
| edit failures | **0** (0/21 edits failed) |
| syntax-gate rejections | 9 — all correctly caught and recovered from |
| export-preservation rejections | 0 (none needed) |
| lost exports/functions | **0** — all 8 baseline symbols preserved 5/5 |
| `allow_removals` / bypass args | **0** |
| masked verification (`\|\|`) | **0** |
| self-authored test infrastructure | **0** |
| workspace artifacts left behind | **0** |
| **New failures** | **none** |

No safety mechanism regressed.

# 12. Aggregate Metrics & Cost

| | |
| --- | ---: |
| Meter before / after | 995.8704¢ → 1035.7812¢ |
| **Total** | **39.911¢ = $0.3991** |
| Cost per run | **$0.0798** |
| Cost per successful run | **$0.0798** (5/5) |
| Tokens | 1,443,946 in / 19,052 out |
| LLM calls | 127 |
| Cumulative all phases | $0.6423 |
| **Remaining budget** | **~$0.358** |

# 13. Before vs After Fix A

| Metric | qwen before Fix A | qwen after Fix A |
|---|---:|---:|
| Valid runs | 5/5 | 5/5 |
| PASS | 5/5 | **5/5** (unchanged) |
| `verification_grace` fired | n/a (did not exist) | **5/5** |
| Runs invoking bash | **0/5** | **4/5** |
| Total bash calls | **0** | **32** |
| Runs with recorded verification | **0/5** | **4/5** |
| Verification events | 0 | 13 |
| `no_progress` termination | **5/5** | **1/5** |
| `verified` / normal finish | 0/5 | **4/5** |
| False verification | 0/5 | 0/5 |
| Lost exports | 0/5 | 0/5 |
| Total cost | $0.128 | **$0.399 (3.1×)** |
| Cost per run | $0.0256 | **$0.0798** |

# 20. Final Verdict

**1. Did Fix A work mechanically?** **YES.** `verificationGraceUsed=true` in 5/5, exactly once each,
including the run that ignored it.

**2. Did Qwen respond to the verification directive?** **YES in 4/5.** Bash invocation went 0→4/5 and
0→32 calls, with the model reaching for `node --check` and ad-hoc behavioural scripts.

**3. Did valid verification increase from 0/5?** **YES — 0/5 → 4/5**, with the quality caveats in §15
(one run is parse-only; most scripts print rather than assert).

**4. Did bash usage increase from 0/5?** **YES — 0/5 → 4/5.**

**5. Did `no_progress`-before-verification decrease?** **YES — 5/5 → 1/5.**

**6. Did PASS rate change?** **No — 5/5 both before and after.** Fix A did not improve correctness on
this task and was never expected to; qwen was already saturating it.

**7. Did cost increase?** **YES, substantially — 3.1×** ($0.0256 → $0.0798 per run). This is the
predicted cost of actually verifying, but it is larger than the "one extra turn" I estimated: LLM
calls rose 51 → 127, driven by a-fs-2 spending 12 bash calls fighting ESM `node -e` quoting.

**8. Did any safety mechanism regress?** **No.** Zero masked commands, zero infra authoring, zero
lost exports, zero bypass attempts, zero artifacts.

**9. Is the remaining problem controller-side or model-side?** **Model-side, with one controller
issue still open.** The controller now asks in 5/5; the model declined in 1/5 (a-fs-4) — that is
model compliance, not a deadlock. The open controller defect is the separate `no_progress` misreport,
which a-fs-4 reproduced exactly (8/8 PASS reported as "I did not finish this task").

**10. Is Kodo ready for the broader Claude Code comparison?** **Qualified yes.** The scaffolding is
sound: 0 edit-before-read, 0 lost exports, 0 false verification, verification now occurring in 4/5.
Two caveats before running it: (a) the `no_progress` misreport will understate Kodo on any run where
the model skips verification, and should be fixed first; (b) at $0.0798/run and ~$0.358 remaining,
a 5-task cross-agent suite costs ~$0.40 and **would exceed the remaining budget** — it needs either
a budget top-up or a reduced task set.

## Interpretation, per the brief's rule

This is **not** the "5/5 PASS, 0/5 verification" case. Verification moved 0/5 → 4/5 while the task
stayed 5/5, which is strong evidence Fix A resolved the controller deadlock for this model and task.
The residual 1/5 is **model non-compliance, cleanly separated from controller behaviour**: the
directive fired, the model ignored it, and the bounded fallback behaved exactly as specified.

Five runs on one task with one model. I am not generalising beyond that.
