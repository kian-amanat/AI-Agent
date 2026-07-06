---
name: multi-task-architecture
description: Multi-task runner architecture — LLM decomposition + per-task pipeline — verified working
metadata:
  type: project
---

Multi-task approach is implemented and verified working (2026-07-06).

**Why:** Old single-pass explore shared 6 iterations across all tasks, starving subjects. Old `isMultiTaskRequest` regex missed verbs like "create". PIPELINE_PATTERNS caught "claude code" as a design reference and misclassified as "pipeline".

**Architecture:**
- `backend1/agents/nodes/multi_task_runner.mjs` — self-contained orchestrator
- Router sets `intent="multi_task"` for numbered lists and multi-verb patterns
- `multi_task_runner` calls LLM to decompose → returns `[{description, scopeHint}]`
- For each task: independent `agenticExploreNode` (own 6-iteration budget) → `planChangesNode` → `executeChangesNode` → `verifyNode` (up to 2 retries per task)
- If task 2 fails, task 1's edits are untouched

**Two routing bugs fixed:**
1. Numbered list check (`1- ... 2- ...`) moved BEFORE PIPELINE_PATTERNS in `classifyByHeuristic` — otherwise pipeline fires first
2. `PIPELINE_PATTERNS` "claude code" narrowed to require preceding build verb — bare `/claude code/i` was matching design references like "make it look like claude code"

**How to apply:** When users send `1- task one\n2- task two` or `make X, and also Y`, expect `[Router] intent="multi_task"` and `[MultiTaskRunner] Done: N/N succeeded` in logs. If intent is wrong, check router.mjs ordering.
