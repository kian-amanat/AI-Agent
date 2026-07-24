---
name: feedback-chat-sidebar-width
description: UI preference: ChatSidebar expanded width set to 260px
metadata:
  type: feedback
updated: 2026-07-24T10:17:00.605Z
---

- **Rule**: The `ChatSidebar` expanded width is set to `260px` (reduced from 310px).
- **Implementation**: In `ChatSidebar.tsx`, the width constant/state is `260`. Collapsed width remains `72`.
- **Reason**: User requested a narrower sidebar to save horizontal space while keeping the overall structure intact.
- **Note**: This is a specific UI preference for the chat interface layout.