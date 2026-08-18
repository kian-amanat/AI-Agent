# Kodo P0-2 — Removing the destructive `write_file` bypass

Date: 2026-08-15 · Benchmark, validator, task, model and provider all unmodified. No benchmark was run.

# 1. Root Cause

The export-preservation guard was correct; its **opt-out was placed in the wrong namespace**.

The previous implementation read:

```js
if (existing !== null && !args.allow_removals) {
  const dropped = removedExports(existing, content, absPath);
  ...
}
```

`args` is the tool-call argument object the model itself emits. Anything reachable from `args` is
model-controlled by construction, so `allow_removals` was never a trust boundary — it was a
**parameter of the request being validated**, being used to decide whether to validate the request.
That is circular: the caller authorises itself.

The rejection message made it worse by naming the escape hatch:

> "…or pass `allow_removals:true` if removing them is genuinely intended."

So the guard did not merely permit a bypass, it advertised one. The benchmark shows the model taking
exactly that route — in `v-fs-7` and `v-fs-8` the sequence is:

```
write_file server/api.mjs → REJECTED: "would delete 1 existing export(s): handle"
write_file server/api.mjs → OK, allow_removals: true   ← identical content, one flag added
```

Both rewrites deleted `handle()`. Across the 5 valid runs the guard detected 3/3 destructive
rewrites and was defeated in 2 of them, and **every instance of code loss came through this flag**.

The flag was introduced by the previous fix and existed nowhere else: `grep` found it only in the
schema, the guard, and one test I had written. No pre-existing Kodo workflow used it.

# 2. Tool Boundary

**The model can no longer bypass the guard.** The check is now unconditional for any existing file,
and the parameter has been removed from the schema entirely, so the property holds at the tool
boundary rather than by instruction:

- `write_file` exposes exactly two properties: `path` and `content` (asserted by test 5c).
- Unknown arguments are simply ignored by `executeTool`, so `allow_removals`, `force`, `override`,
  `unsafe`, `confirm` and `yes` are all inert (asserted by test 5b).
- Nothing in the guard consults `args` beyond `path` and `content`.

A confused or adversarial model cannot re-enable a destructive rewrite by changing arguments; there
is no argument left to change.

**Legitimate deletion is preserved, and was not invented for this fix.** `edit_file` carries no
export guard, so removing an export on purpose still works — but it requires quoting that
declaration's exact current text. That is precisely the property a from-memory full rewrite lacks,
which is why the lossy path is closed and the intentional one is not. No approval system, no
workspace-wide analysis, no new authorization concept was added.

# 3. Implementation

### `backend1/agents/nodes/agent_loop.mjs`

| | |
| --- | --- |
| **Previous** | Guard ran only when `!args.allow_removals`; the schema advertised `allow_removals` to the model; the error message told it to use the flag. |
| **New** | Guard is unconditional for existing files. `allow_removals` removed from the schema. Error message directs deliberate removal to `edit_file`. |
| **Why** | A model-settable argument cannot gate a check on that model's own request. Removing it is the smallest change that makes the invariant hold at the boundary. |

Also `const AGENT_TOOLS` → `export const AGENT_TOOLS` (read-only export, no behaviour change) so a
test can assert what the model is actually offered. Without this the schema property could only be
asserted by reading source text.

### `backend1/tests/rewriteSafety.test.mjs`

| | |
| --- | --- |
| **Previous** | Test 5 asserted `allow_removals: true` **permits** deletion — it encoded the defect as intended behaviour. |
| **New** | Test 5 inverted to assert the flag does not bypass; added 5b (equivalent flags), 5c (schema), 5d (`edit_file` deletion path), and the mandatory §9 NEGATIVE test. |
| **Why** | The old test would have locked the bypass in place. |

**Not changed** (per §3): `exportedNames()`, `removedExports()`, `.mjs` syntax validation, and the
verification protections (`masksFailure`, `MISSING_SCRIPT_RE`, `isTestInfraPath`).

# 4. Tests

| Test | Result |
|---|---|
| destructive rewrite (Test A / test 2) | ✅ REJECTED, file unchanged |
| `allow_removals` bypass (Test B / test 5) | ✅ REJECTED — flag inert |
| equivalent override args: `force`, `override`, `unsafe`, `confirm`, `yes` (5b) | ✅ all REJECTED |
| schema exposes no override argument (5c) | ✅ only `path`, `content` |
| original file preservation (Test C / tests 2, 4, NEGATIVE) | ✅ byte-for-byte unchanged |
| legitimate targeted edit (Test D / test 3, B) | ✅ succeeds |
| new file (Test E / test 6) | ✅ succeeds, ungated |
| `.mjs` syntax validation (Test F / D, D2) | ✅ still enforced |
| deliberate deletion via `edit_file` (5d) | ✅ succeeds, syntax valid |
| **§9 NEGATIVE — exact v-fs-7/v-fs-8 failure** | ✅ **both attempts rejected, file unchanged** |

**19/19 focused tests pass** (`rewriteSafety` 11 + `editSafety` 8).

Verified the tests actually detect the defect: reinstating **only** the `&& !args.allow_removals`
condition makes tests 5, 5b and the NEGATIVE test fail (8 pass / 3 fail). The fix was then restored
and confirmed green.

# 5. Full Suite

`node --test tests/` → **62 passed / 5 failed of 67.**

| Classification | Tests |
|---|---|
| **NEW FAILURE** | **none** |
| **PRE-EXISTING** | `benchmarkFixtures`, `benchmarkMetrics` — confirmed by stashing all three fix files and re-running: both still fail. `mcpLiveE2E`, `subagentLiveE2E` — require `KODO_E2E_API_KEY`, which is unset. |
| **FLAKY** | `configWatcher` — passes in isolation (1/1). Consistent with the timing flakiness seen across earlier runs, where `sandboxEscape`, `hooks` and `sessionHooks` failed in varying combinations under parallel load and all passed individually. |

Test count rose 63 → 67 from the new cases.

# 6. Remaining Risks

Verified only:

1. **The guard covers `write_file`, not `edit_file`.** An `edit_file` whose `old_string` spans an
   export declaration can still remove it. This is intentional — it is the deliberate-deletion path
   and requires exact current text — but it means export loss is *possible* through `edit_file`. Not
   observed in any of the 10 benchmark runs to date, where every loss came via `write_file`.
2. **`removedExports` fails open by design.** It returns `[]` when either side does not parse or the
   extension is unknown, so a rewrite of an already-broken file is not export-checked. The syntax
   gate owns that case; the alternative would be false accusations of deletion.
3. **Only top-level exports are protected.** Removing a non-exported helper that other code in the
   same file depends on is not detected. Out of scope, and not the observed failure.
4. **Untested against the benchmark.** Per §12 no benchmark was run. Whether removing the bypass
   changes live-run outcomes is unmeasured — in particular the model may now stall where it
   previously bypassed, since a rejection with no escape hatch could increase `no_progress` stops.
   That is a real possibility and is not yet evidence either way.

# 7. Verdict

**FIXED** — for the stated objective: a model-issued `write_file` can no longer bypass
export-preservation safety by setting an argument. The property is enforced at the tool boundary,
holds against the exact observed bypass and five equivalent flag names, and is covered by a
regression test that fails on the old behaviour.

Scope note: this verdict covers the bypass only. **Code preservation in live runs remains unproven**
until the 5-run benchmark is re-run, which §12 defers.
