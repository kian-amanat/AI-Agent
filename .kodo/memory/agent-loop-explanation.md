---
name: agent-loop-explanation
description: Core agent implementation explanation for agent_loop.mjs
metadata:
  type: reference
updated: 2026-07-20T21:43:02.301Z
---

## agent_loop.mjs — Complete Explanation

This is the core agent implementation that handles the entire workflow for making changes to your codebase. Let me break it down into clear sections:

### 1. **Overall Purpose & Architecture**

This is a **Claude Code-style unified agent** that follows a single loop pattern:
- The model gathers context → makes tool calls → gets results → repeats
- Continues until the model replies with plain text (the final answer)
- Handles everything: reading files, editing files, running commands, etc.

### 2. **Key Components**

**Agentic Loop Structure:**
- `agenticExploreNode` - Explores codebase and gathers context (6 iterations budget)
- `planChangesNode` - Plans the changes needed
- `executeChangesNode` - Executes the planned changes
- `verifyNode` - Verifies changes were successful (up to 2 retries)

**Flow:**
1. Router determines if request is multi-task or single task
2. For single tasks: enters agent_loop
3. Loop continues until model outputs plain text (final answer)
4. Handles all tool calls within the loop

### 3. **Integration with System**

**LangGraph Integration:**
- Part of `backend1/agents/nodes/kodo_graph.mjs` state graph
- Connected to router node that decides between `answer` or `agent_loop`
- Uses `KodoStateAnnotation` for typed state management

**Persona Integration:**
- Updated to support Claude Code persona (direct, opinionated, efficient)
- Modified `answer.mjs` system prompt enforces this personality
- Agent loop adapted to match this communication style

### 4. **Error Handling & Resilience**

**Retry Logic:**
- `verifyNode` runs up to 2 retries for each task
- If task 2 fails, task 1's edits remain untouched
- Patch mismatch handling (re-read files when edits fail)

**Bug History:**
- Fixed routing bugs in `classifyByHeuristic` (numbered lists before pipeline patterns)
- Fixed multi-task decomposition regex to catch more verbs
- Git branch fetch issues in ChatComposer

### 5. **Current State**

**Recent Updates:**
- Persona shift from verbose to direct communication style
- Anti-patterns banned: "I can help with that", "Great question", "Certainly"
- Action-oriented responses with minimal preamble
- Constraint: Do NOT modify UI files for persona changes

This file represents the core agentic workflow that powers Kodo's ability to make changes to your codebase through an iterative, context-gathering approach.