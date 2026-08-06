# Kodo benchmarks

The evaluation layer for Kodo. Each benchmark puts the real agent in front of a
real task in an isolated workspace, records everything it did, and then scores
the result **from what is on disk** — never from what the agent said about it.

The framework lives in [`backend1/bench/`](../backend1/bench/); the tasks live here.

## Running

```bash
npm run bench -- list                      # what exists
npm run bench -- run --golden              # the regression set
npm run bench -- run --id debug/failing-test-fix
npm run bench -- run --family react,nextjs --repeat 3

npm run bench -- baseline <runId>          # promote a run to the baseline
npm run bench -- compare baseline <runId>  # …and diff against it later
npm run bench -- replay <runId> <benchmarkId> --verbose
```

`run` drives the real agent against a real model: it costs money and takes
minutes. It needs `OPENAI_API_KEY` (plus optionally `DEFAULT_MODEL`,
`OPENAI_BASE_URL`) and will tell you plainly if they're missing rather than
reporting failures. Everything else — `list`, `report`, `compare`, `replay` —
works offline against stored artifacts.

Exit codes: `0` everything passed · `1` failures or regressions · `2` something
was **blocked** and therefore never evaluated.

## Outcomes

| Outcome | Meaning |
| --- | --- |
| `pass` | every critical check passed |
| `partial` | some real progress, task not finished |
| `fail` | no progress, and the run ended normally |
| `stopped_early` | no progress, and the agent gave up (no_progress / thrashing / budget) |
| `needs_user` | no progress, and the agent stopped to ask a question |
| `blocked` | the benchmark could not be evaluated at all — missing tool, missing credentials, broken fixture, validator that couldn't reach a verdict |

A `blocked` run is never a pass and is never folded into `fail`: the reason
travels with it into the report, and the CLI exits `2`. A suite that cannot run
must not be able to report a flattering number.

## Layout

```
benchmarks/<family>/<name>/
  prompt.md        the user message, sent verbatim
  expected.md      what "done" looks like, and what this benchmark is guarding against
  metadata.json    difficulty, golden, capabilities, timeouts
  validator.mjs    default-exports async ({ workspace, run, helpers }) => checks
  workspace/       optional fixture tree, copied into the isolated workspace
```

Families: `frontend` `backend` `fullstack` `debug` `refactor` `performance`
`tests` `typescript` `react` `nextjs`.

## Writing a validator

Validators answer one question: **did the work actually happen?** They read the
post-run workspace, import its modules, and run its commands.

```js
import { check, guard, behaviourCheck, importFromWorkspace } from "../../_lib/checks.mjs";

export default async function validate({ workspace, helpers, run }) {
  const checks = [];

  // A guard: already true before the run. Breaking it fails the run; passing
  // it is NOT progress — an agent that did nothing satisfies every guard.
  checks.push(guard("the existing route still works", /* … */));

  // Progress: what the task actually asked for.
  checks.push(await behaviourCheck("the new endpoint responds 200", async () => {
    const api = await importFromWorkspace(workspace, "server.mjs");
    const res = api.handle("GET", "/api/health");
    if (res?.status !== 200) return `expected 200, got ${JSON.stringify(res)}`;  // failure detail
  }));

  // Advisory: costs score, never decides pass/fail.
  checks.push(check("only touched the file it needed to", /* … */, "", { critical: false }));

  return checks;
}
```

Three rules, each learned from a way benchmarks go quietly useless:

1. **Prefer behaviour to text.** Import the module and call it; run the test
   suite; count the scans. `grep`ping for a function name proves it was typed,
   not that it works.
2. **Mark guards.** Anything that was already true is a `guard`. Without this,
   a run that changed nothing scores `partial` because the fixture still parses.
3. **Never credit a self-report.** `run.finalAnswer`, `run.editedFiles` and the
   agent's todo list are available *only* so a validator can catch it
   overstating what it did. `run.workspaceChanges` is the measured truth.

A validator that throws becomes a **blocker**, not a failure — that's how a
missing tool (no TypeScript compiler, say) is reported honestly. A validator
with no critical non-guard checks is rejected outright, because it could only
ever award vacuous passes.

Both properties are enforced by the test suite: `tests/benchmarkE2E.test.mjs`
runs the entire corpus against a do-nothing agent and requires that **nothing**
passes, then hands each benchmark a correct solution and requires that it does.
So a new benchmark has to be both non-vacuous and satisfiable to land.

## Artifacts

Every run writes to `.bench-runs/<runId>/` (gitignored, and deliberately
separate from the agent's live memory in `memory.db` / `.agent-history/`):

```
summary.json                        the whole run + metrics
benchmarks/<id>/result.json         outcome, checks, metrics, changed files
benchmarks/<id>/transcript.jsonl    every event, in order
benchmarks/<id>/timeline.json       every tool call: args, status, duration, output
benchmarks/<id>/workspace.json      before/after content hashes and the diff
benchmarks/<id>/replay.json         all of the above, plus the post-run content
                                    of every changed file
```

`replay.json` is self-contained on purpose: debugging a failed run should never
require re-running it against a model that may not reproduce it.
