# Kodo Fullstack Fix Report

Date: 2026-08-15 · Baseline `870a170` · Model `gpt-4.1-nano` via `https://api.gapgpt.app/v1`
Before-artifacts: `.bench-runs/repro-fs-{1..5}/` · After-artifacts: `.bench-runs/fixed-fs-{1..5}/`
Task, validator, scoring, model, provider and prompt were **not** modified.

## Root Cause

The investigation brief's stated premise turned out to be wrong, and the evidence has to override it.

**The read-before-edit guard already existed** — `agents/nodes/agent_loop.mjs:2411`:

```js
if (!ctx.readFiles.has(relPath)) return { success: false, error: `Read ${relPath} first (read_file) before editing it.` };
```

**And the `old_string` values were not hallucinated.** From the run-1 tool trace:

| file | `old_string` supplied | present in fixture? |
| --- | --- | --- |
| `server/api.mjs` | `export const routes = [` | yes, exact |
| `client/apiClient.mjs` | `export async function getUsers() {` | yes, exact |
| `client/App.mjs` | `export async function renderUser(id) {\n  // TODO: fetch and render a single user by id\n  return "";\n}` | yes, exact — including the TODO comment |

Kodo had the file contents because `agent_loop.mjs:3259-3270` pre-seeds any file whose path the user
message names: it reads the file, injects it into the prompt, and records it in `ctx.readFiles`. The
fullstack prompt names all three files, so all three were legitimately read. No guard was bypassed.

The real defect is two independent things:

**1. The edit shape.** The model anchored on a construct's *opening line* and supplied a `new_string`
that re-*closed* the construct. `export const routes = [` was replaced by a complete new array
**including its own `];`**, so the original array body was orphaned after it:

```js
];              // ← new array closes here
  {
    method: "GET",     // ← orphaned original body. SyntaxError: Unexpected token ':'
```

**2. The gate that should have caught it was disabled for the file type.** `utils/syntax.util.mjs:107`:

```js
if (![".tsx", ".jsx", ".ts", ".js"].includes(ext)) return null;   // .mjs → returns "clean"
```

`.mjs` was absent, so `validateSyntax` returned `null` — "no problem" — for every ESM source file.
Both `edit_file` (line 2425) and `write_file` (line 2460) call it, so both silently no-opped on
exactly the files a Node project is made of. Proven directly on identical content:

```
.mjs → null                                            (accepted)
.js  → "L6: ';' expected.; L7: Expression expected."   (rejected)
```

That is why the corruption reached disk and the tool reported `{"success":true}`. Kodo's recovery
loop was never given anything to recover from.

## Changes Made

Two files. No agent-loop, tool, scoring, validator, task, model or provider changes.

### 1. `backend1/utils/syntax.util.mjs`

Added `.mjs`, `.cjs`, `.mts`, `.cts` to the syntax-validated extension list, and routed `.mts`/`.cts`
to the TS `ScriptKind`. The module flavour in the extension changes nothing the parser cares about;
omitting them disabled the only structural gate protecting ESM files. **This is the change that fixes
the reported defect.**

### 2. `backend1/services/taskController.mjs`

- **`masksFailure(command)`** (new, exported) — recognises a command whose exit code cannot report
  failure: `||` fallbacks, `; true`, `set +e`. `&&` chains and pipelines are untouched, and
  `|| exit 1` / `|| false` are explicitly *not* masks because they re-raise. Required by Fix #3:
  `npm test || echo 'no test script'` always exits 0 precisely *because* the test failed.
- **`verificationOutcome(ok, output, command)`** — gained the optional third argument. A masked
  command is recorded as a failed verification with the reason attached, so it cannot certify the
  workspace. The command still runs; it simply stops counting as proof.
- **`MISSING_SCRIPT_RE`** — `Missing script` / `no test specified` / `command not found` is reported
  as *missing* verification, never passing verification (Fix #3's "absent suite ≠ passing tests").
- **`isTestInfraPath(p)`** (new, exported) — classifies test files, `package.json`, `tsconfig*.json`
  and the common runner configs as harness rather than implementation.
- **`onlyTestInfraChangedSinceLastVerification()`** + `lastImplMutationAt` / `lastInfraMutationAt` —
  Fix #4. A check that goes green when the *only* thing changed since the last check was the harness
  is not evidence about the implementation, so it is not credited. Editing test infrastructure stays
  fully permitted — the rule only bites when nothing else moved.

## Focused Tests

New file `backend1/tests/editSafety.test.mjs`, 8 tests. Verified to fail on the old behaviour by
reverting only `syntax.util.mjs` (`git stash`) and re-running:

| Test | Before fix | After fix |
| --- | --- | --- |
| A — edit an unread file | ✅ pass (guard already existed) | ✅ pass |
| B — read, then edit | ✅ pass | ✅ pass |
| C — stale/incorrect `old_string` | ✅ pass | ✅ pass |
| **D — orphaning edit on `.mjs`** | **❌ FAIL — corruption written, `success:true`** | ✅ pass — rejected, file unchanged |
| **D2 — `validateSyntax` covers `.mjs/.cjs/.mts/.cts`** | **❌ FAIL** | ✅ pass |
| E — `\|\|`-masked exit code cannot certify | ✅ pass (new logic) | ✅ pass |
| F — missing script ≠ passing tests | ✅ pass (new logic) | ✅ pass |
| G — test-infra vs implementation paths | ✅ pass (new logic) | ✅ pass |

A/B/C pass in both columns, and that is the honest result: they cover a guard that was already
correct. They are kept as regression coverage so it cannot be removed silently.

Existing suites: `node --test tests/` → **52 pass / 4 fail**. All 4 failures (`benchmarkFixtures`,
`benchmarkMetrics`, `mcpLiveE2E`, `subagentLiveE2E`) were confirmed **pre-existing** by stashing both
fixes and re-running — the live-E2E pair needs `KODO_E2E_API_KEY`, which is unset.

## 5-Run Reproduction

Identical protocol to the before-run: same task, same validator, clean baseline per run, no intervention.

| Run | Result | Syntax corruption | Edit-before-read (no prior `read_file`) | Regression | Verification | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 🟡 partial 3/8 (0.36) | none — 1/1 file parses | seeded only; 2 corrupting edits **rejected** | no | honest, no claim | ~$0.0029 |
| 2 | 🟡 partial 4/8 (0.48) | none — 2/2 parse | seeded only; 2 **rejected** | no | honest, no claim | ~$0.0029 |
| 3 | 🟡 partial 4/8 (0.48) | none — 2/2 parse | seeded only; 2 **rejected** | no | honest, no claim | ~$0.0058 |
| 4 | 🟡 partial 6/8 (0.76) | none — 3/3 parse | seeded only; 6 **rejected** | yes — dropped `setTransport` export | honest, no claim | ~$0.0066 |
| 5 | 🚧 blocked 0/1 | none — 2/2 parse | seeded only; 4 **rejected** | yes — dropped `handle()` export | honest, no claim | ~$0.0043 |

The syntax gate fired **16 times across the 5 runs**, each time rejecting an edit that would
previously have corrupted a file, and each time Kodo responded with `read_file` → retry. The recovery
loop the brief predicted would engage, engaged. Run 1's trace is the pattern:

```
todo_write → edit_file✗ → edit_file✗ → edit_file → edit_file✗ → read_file → edit_file → read_file → edit_file → write_file
```

## Before vs After

| Metric | Before | After |
| --- | ---: | ---: |
| Success rate | 0/5 | 0/5 |
| Partial (real, scored progress) | **0/5** | **4/5** |
| Blocked (workspace unevaluable) | **5/5** | **1/5** |
| Mean validator score | **0.00** | **0.42** |
| Syntax corruption | **14/15 files** | **0/10 files** |
| Destructive unread-file edits | 15 | **0** |
| Regressions | **5/5** | **2/5** |
| False verification / false success | **2/5** | **0/5** |
| Unnecessary edits | 2 runs | 2 runs (`package.json`, scratch artifact) |
| Kodo cost | $0.0111 | $0.0224 |

## Remaining Problems

**The task still does not pass, for a different and legitimate reason — reported, not hidden.**

1. **`write_file` fallback drops pre-existing exports.** This is now the dominant failure. When the
   syntax gate rejects an edit, Kodo falls back to rewriting the whole file, and reconstructs it from
   memory without every existing export. Run 4 lost `setTransport` (`client.setTransport is not a
   function`), run 5 lost `handle()` (`server/api.mjs no longer exports handle()`). Both are real
   regressions, and run 5's is what made it `blocked`. My fix did not cause this, but it did make it
   the binding constraint by closing the corrupt-edit path that used to fail earlier and louder.
2. **Route implementation is still frequently wrong.** Runs 1–3 returned 404 for `GET /api/users/u1`
   — the parameterised regex route was never landed correctly. Run 1 never successfully modified
   `server/api.mjs` at all.
3. **Cost roughly doubled** ($0.0111 → $0.0224) because rejected edits are retried. That is the
   intended trade — the runs now do real work instead of failing fast into corruption — but it is a
   real cost increase.
4. The `.kodo/tasks/bg_*.output` scratch artifact still lands inside the workspace (run 5).

Fixes #3 and #4 are covered by unit tests but were **not exercised in these five runs** — no run
issued a `||`-masked verification this time. Their benchmark-level effect is therefore unmeasured; I
am not claiming evidence for them beyond the unit tests.

## Conclusion

**PARTIALLY FIXED.**

The specific reproducible defect — an edit corrupting an `.mjs` file, reaching disk, and being
reported as success — is **fixed**, with direct evidence: 14/15 corrupted files before, 0/10 after;
16 corrupting edits now rejected with a recoverable error; 0/5 false success claims, down from 2/5;
blocked runs down from 5/5 to 1/5; mean score 0.00 → 0.42.

The benchmark still does not pass, so the task-level outcome is not fixed. The cause is now a
different defect — full-file `write_file` rewrites that drop pre-existing exports — which should be
investigated separately. Per the brief's instruction not to fix beyond the reported failures, I have
not touched it.
