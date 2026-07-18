---
updated: 2026-07-18T19:51:52.387Z
---

- **Frontend App**: `chatbot/my-chatbot-ui`.
- **Backend**: `backend1`.
- **New Feature**: Git Branch Switching in Chat Composer.
  - **Frontend**: `ChatComposer.tsx` now includes a dropdown to view and switch branches.
  - **API**: `api.ts` exports `fetchGitBranches` and `switchGitBranch`.
  - **Backend Route**: `workspace.mjs` exposes `/api/workspace/git/branches` and `/api/workspace/git/checkout`.
- **Stack**: React, Next.js, `framer-motion`, `lucide-react`.
- **Constraint**: No new dependencies added.
- **UI Section Update**: User requested replacing "How it works" section with "Colors used in Kodo" section, leveraging project color palette.
