---
name: feedback-copy-button-ui
description: UI preference: remove static copy button entirely
metadata:
  type: feedback
updated: 2026-07-23T20:45:38.479Z
---

- **Rule**: Remove the static "Copy" button from assistant messages completely.
- **Implementation**: Removed the `Copy` message button under the assistant message bubble in `AssistantMessage.tsx`. Also cleaned up unused `copied` state variable.
- **Reason**: Cleaner UI, reduces visual clutter in the chat interface.
- **Note**: Only keep copy functionality if it appears on hover (if implemented separately), but the static button is gone.