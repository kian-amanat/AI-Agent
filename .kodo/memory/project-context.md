---
updated: 2026-07-05T16:12:17.458Z
---

- **Backend Integration Pattern**:
  - Backend logic resides in `backend1` directory.
  - Correct endpoint implementation for sending messages is `/api/agent/run`.
  - **Abort Endpoint**: New endpoint required (e.g., `/api/agent/abort`) to handle AbortController signal cancellation.
  - Frontend `api.ts` must handle the API call to this endpoint.
  - `ChatComposer.tsx` consumes the function from `api.ts`.
- **Agent Structure**:
  - Agents located in `backend1/agents/` (e.g., `kodo_graph.mjs`).
  - Must follow existing function structure but include AbortController support.
  - State annotation (`KodoStateAnnotation`) now includes `abortSignal`.
  - Graph runner (`graph_runner.mjs`) manages signal propagation.
- **Testing Protocol**:
  - Verify backend functionality using `curl` commands against the endpoint.
- **Existing Structure**:
  - `api.ts` already contains structure for calling `/api/agent/run`.
  - `ChatComposer.tsx` uses `api.ts` sendMessage function.