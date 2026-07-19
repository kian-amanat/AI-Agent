---
updated: 2026-07-19T15:50:48.520Z
---

- **Frontend App**: `chatbot/my-chatbot-ui`.
- **Backend**: `backend1`.
- **Stack**: React, Next.js, `framer-motion`, `lucide-react`.
- **Backend Architecture**: Uses **LangGraph** for agent orchestration.
  - Core file: `backend1/agents/nodes/kodo_graph.mjs`.
  - Imports: `StateGraph`, `END`, `START` from `@langchain/langgraph`.
  - State Schema: `KodoStateAnnotation` with typed channels, reducers, and defaults.
  - Graph Structure: `START → router → (answer | agent_loop) → END`.
- **Recent Feature**: Git Branch Switching in Chat Composer.
  - Frontend: `ChatComposer.tsx` dropdown.
  - API: `api.ts` exports `fetchGitBranches`, `switchGitBranch`.
  - Backend Route: `workspace.mjs` exposes `/api/workspace/git/branches` and `/api/workspace/git/checkout`.
- **UI Section Update**: Replaced "How it works" with "Colors used in Kodo".
- **Recent Component**: Created `n8n-workflow-block-shadcnui.tsx` in `components/ui/`.
- **Recent UI Change**: Replaced `ParallaxFeatureStrip` with `KodoInActionSection` in `landing2/page.tsx`.