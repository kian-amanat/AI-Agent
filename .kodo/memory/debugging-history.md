---
updated: 2026-07-06T18:02:17.102Z
---

- **Bug**: Abort button in UI did not stop the agent workflow.
- **Status**: Fixed by updating `chatbot/my-chatbot-ui/app/page.tsx`.
- **Note**: The fix involved ensuring the `onStop` prop correctly propagated the abort signal to the backend agent execution.