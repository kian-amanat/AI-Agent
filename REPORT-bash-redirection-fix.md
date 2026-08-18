# Bash Redirection Segmentation Fix

Scope: one confirmed tool-layer defect. No benchmark was run. **$0.00 spent** — this task required no
model calls.

## Root Cause

`splitBashSegments()` in `backend1/agents/nodes/agent_loop.mjs` walks the command character by
character and treats `;`, `|` and `&` as command separators when not inside quotes:

```js
if (ch === ";" || ch === "|" || ch === "&") {
  if ((ch === "|" || ch === "&") && raw[i + 1] === ch) i++;   // collapse `&&` / `||`
  segments.push(current); current = ""; continue;
}
```

The only special case was the *doubled* form (`&&`, `||`). Nothing accounted for the `&` that lives
inside bash's **redirection operators**:

| operator | meaning |
| --- | --- |
| `>&` / `<&` | duplicate a file descriptor — `2>&1`, `>&2`, `1>&2`, `<&0` |
| `&>` / `&>>` | redirect stdout *and* stderr at once |

So in `npm test 2>&1` the scan reaches `&` with `current = "npm test 2>"`. The next character is `1`,
not `&`, so the doubled-form branch does not fire, the accumulated text is pushed as a finished
segment, and `1` starts a new one:

```
"npm test 2>&1"  →  ["npm test 2>", "1"]
```

`validateBashCommand` then validates every segment independently. The second segment's first token is
`1`, which is not in `BASH_ALLOWED_CMDS`, producing:

> `command "1" is not in the allowed list (node, npm, npx, yarn, …)`

The whole command was refused. Since `2>&1` is punctuation on nearly every verification command, this
silently blocked the agent from checking its own work — observed in benchmark run **x2**, where a
*correct* fix (validator 5/5) could never be confirmed: 4 of 5 verification attempts were rejected
and the run terminated `blocked`.

### Was the splitting intentional?

Yes — and the fix preserves that intent. Per the comment above `parseBashRule`, permission matching
is deliberately **per segment** rather than over the whole string, so `git status | rm -rf /` cannot
ride in on a `Bash(git status:*)` allow rule. Quote-skipping was likewise a deliberate earlier fix
(`echo 'const a = 1;' > f.js` used to split on the quoted `;`). Redirection operators containing `&`
were simply never considered.

### Note on existing coverage

`tests/livePipeline.test.mjs:116-119` already *documents* `npm test 2>&1` as ordinary punctuation and
feeds it through the bash tool — but it only asserts `mutations === 0`, which holds whether the
command runs or is rejected. The intent was recorded; the assertion was too weak to catch this.

## Files Changed

| File | Change | Why |
| --- | --- | --- |
| `backend1/agents/nodes/agent_loop.mjs` | `splitBashSegments()` — `&` is not a separator when it is part of a redirection operator | The defect itself |
| `backend1/tests/bashRedirection.test.mjs` | new — 17 tests | Regression coverage |

Hash: `agent_loop.mjs 3adb0306… → df025cf5…`. **`taskController.mjs` (`844b230a…`) and
`syntax.util.mjs` (`6ccec126…`) are byte-identical** — verificationGrace, the write_file export guard
and the syntax gate were not touched. `git diff HEAD -- benchmarks/` is empty.

The change is four lines of logic:

```js
if (ch === "&" && (current.endsWith(">") || current.endsWith("<") || raw[i + 1] === ">")) {
  current += ch;
  continue;
}
```

Adjacency is required, matching bash: `>&` is a single token only when the characters touch, so a
deliberate background-then-redirect (`foo & > x`) still separates.

## Tests Added

`backend1/tests/bashRedirection.test.mjs` — all 17 pass.

| # | Case | Assertion |
| --- | --- | --- |
| A | `npm test` | unchanged, accepted |
| B | `npm test 2>&1` | one segment; no segment equals `"1"`; accepted |
| C | `npm test > output.log` | intact |
| D | `npm test 2> error.log` | intact |
| E | `npm test >> output.log` | intact |
| F | `npm test < input.txt` | intact |
| G | `npm test && npm run build` | two executable segments |
| H | `npm test \|\| npm run fallback` | two executable segments |
| I | `echo "a & b"` | no split inside quotes |
| J | `echo "2>&1"` | no command `"1"` |
| K | `npm test 2>&1 && npm run build` | `["npm test 2>&1", "npm run build"]` |
| L | `npm test && npm run build 2>&1` | `["npm test", "npm run build 2>&1"]` |
| M | `>&2`, `&> out.log`, `&>> out.log`, `1>&2` | all intact |
| SEC 1 | `npm test 2>&1 && rm -rf /` etc. | second command still caught |
| SEC 2 | `npm test & badcmd` | backgrounding still separates; `& > out.log` (spaced) still splits |
| SEC 3 | 10 pre-existing rejections verbatim from `agent_loop.test.mjs` | still rejected |
| SEC 4 | `1`, `npm test && 1` | a bare descriptor number is still not a command |

**Verified the tests detect the defect:** with only `agent_loop.mjs` stashed, **5 fail** (B, K, L, M,
SEC 1) and 12 pass. The 12 that pass either way are the guards proving surrounding behaviour is
unchanged — including SEC 3 and SEC 4, which is exactly what "the allowlist was not weakened" means.

## Before / After

| Command | Before | After |
| --- | --- | --- |
| `npm test` | `["npm test"]` → ok | `["npm test"]` → ok |
| `npm test 2>&1` | `["npm test 2>", "1"]` → **REJECTED** | `["npm test 2>&1"]` → **ok** |
| `npm test && npm run build` | `["npm test", "npm run build"]` → ok | *(unchanged)* → ok |
| `npm test \|\| npm run fallback` | `["npm test", "npm run fallback"]` → ok | *(unchanged)* → ok |
| `npm test 2>&1 && npm run build` | `["npm test 2>", "1", "npm run build"]` → **REJECTED** | `["npm test 2>&1", "npm run build"]` → **ok** |
| `npm test && npm run build 2>&1` | `["npm test", "npm run build 2>", "1"]` → **REJECTED** | `["npm test", "npm run build 2>&1"]` → **ok** |

## Security Analysis

**The fix is parser-correct, not allowlist-relaxed.** `BASH_ALLOWED_CMDS` is untouched, no rule was
added, and `"1"` remains an invalid command (SEC 4 asserts `validateBashCommand("1")` still rejects).

The change **narrows** what counts as a separator, which cannot grant new capability — it only stops
the parser inventing a command that the user never wrote. Every surviving segment is still passed
through the full validation chain: deny rules, the baseline allowlist, inline-eval blocking,
workspace confinement, and secret-file checks.

The property that matters — a chained command cannot smuggle itself past per-segment validation — is
preserved and directly tested. `npm test 2>&1 && rm -rf /` still splits into two segments and is
still rejected (SEC 1), as are `| badcmd`, `; badcmd` and `&& cat /etc/passwd` variants.

Adjacency keeps backgrounding intact: `npm test & badcmd` still separates (SEC 2), so a backgrounded
second command cannot ride along unchecked — the original reason `&` was a separator at all.

One deliberate limitation: the unbalanced-quote fallback still uses the naive regex split, so a
*malformed* command containing `2>&1` would still fragment. That path is fail-closed by design (an
unbalanced quote is a shell syntax error), and widening it would relax the safest branch. Left as-is.

## Test Results

| Scope | Baseline (pre-fix) | After fix |
| --- | --- | --- |
| Focused (`bashRedirection`) | n/a — 5/17 would fail | **17/17** |
| Relevant existing (`agent_loop`, `core`, `runtimeBoundary`, `hooks`, `promptGating`) | **5/5 pass** | **5/5 pass** |
| Safety + verification (`rewriteSafety`, `editSafety`, `verificationGrace`, `taskController`, `livePipeline`, `bashRedirection`) | — | **46/46 pass** |
| Full suite | — | **88 passed / 4 failed of 92** |

**Pre-existing failures (4), none introduced by this fix:**

- `benchmarkFixtures`, `benchmarkMetrics` — confirmed pre-existing by stashing all three production
  fixes and re-running: both still fail.
- `mcpLiveE2E`, `subagentLiveE2E` — require `KODO_E2E_API_KEY`, which is unset.

**New failures: none.** Test count rose 75 → 92 (17 new).

No verification command used `||`, `; echo`, or a modified `package.json`; every command above can
fail and did fail before the fix.

## Remaining Issues

Recorded, not fixed — all out of scope for this task:

1. **MISCLASSIFIED_COMPLETION** — a complete, validator-passing run can still report *"I did not
   finish this task"*, observed on both the `no_progress` and `blocked` paths. Unrelated to this
   parser defect.
2. **Unbalanced-quote fallback** still splits naively (see Security Analysis). Deliberate.
3. **Verification quality** — the cross-task benchmark found agents producing parse-only or
   non-importing checks. A model/behaviour issue, not a parser one.
4. The 4 pre-existing test failures above.

**No benchmark was run, per instruction. Stopping here.**
