# Agent benchmark comparison

Corpus: **3** benchmark(s) · repeats: **2** · agents: **2**

## Overall ranking

Ranked on quality only — completion, then independent verification, then honesty, then restraint. Cost and speed are reported but never buy rank.

| # | Agent | Model | Completion | Verified | False pos. | False neg. | Flaky | Blocked |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `claude-code` | gpt-4.1-nano | 100.0% | 4/4 | 0 | 2 | 0 | 0 |
| 2 | `kodo` | gpt-4.1-nano | 100.0% | 3/3 | 0 | 2 | 0 | 0 |

## Per-benchmark heatmap

`P` pass · `~` partial · `F` fail · `S` stopped early · `Q` needs user · `B` blocked · `·` not run. A cell shows the **worst** of that benchmark's repeats.

| Benchmark | `claude-code` | `kodo` | Agree |
| --- | --- | --- | --- |
| `debug/failing-test-fix` | P | P |  |
| `debug/honest-blocker-missing-tool` | P | P |  |
| `react/command-palette-resume` | P | P |  |

`*` marks a benchmark whose repeats disagreed — the agent is flaky there, which is itself a result.

## Per-category pass rate

| Category | `claude-code` | `kodo` |
| --- | --- | --- |
| debug | 100.0% (2/2) | 100.0% (2/2) |
| react | 100.0% (1/1) | 100.0% (1/1) |

## Quality

Median ± population standard deviation across repeats. Every metric here is derived from the workspace, the validators, or the agent's own words — never from agent-reported internals, so it is comparable across drivers.

| Metric | `claude-code` | `kodo` |
| --- | --- | --- |
| score | 1.00 | 1.00 |
| critical checks passed | 1.00 | 1.00 |
| optional checks passed | 1.00 | 1.00 |
| files changed | 1.00 ±1.25 | 1.00 ±1.10 |
| lines changed (churn) | 2.00 ±33.50 | 2.00 ±26.02 |
| tool calls | 2.00 | 8.00 ±3.72 |
| unnecessary re-edits | 0.00 | 0.00 |
| loop score | 0.00 | 0.09 ±0.05 |

## Cost and speed

`—` means the agent does not report that figure. It is **not** zero: an external CLI agent exposes no token accounting, and printing 0 would make it look free.

| Metric | `claude-code` | `kodo` |
| --- | --- | --- |
| telemetry available | no | yes |
| iterations | — | 9.00 ±3.72 |
| total tokens | — | 57623.00 ±26161.56 |
| est. cost (USD) | — | — |
| duration | 74.7s | 107.4s |

## Failure analysis

### `claude-code`

Every benchmark passed on every repeat.

### `kodo`

Every benchmark passed on every repeat.

## Strengths and weaknesses

- `claude-code` — strong: debug, react · weak: —
- `kodo` — strong: debug, react · weak: —

