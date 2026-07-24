---
name: user-preferences
description: UI preference: assistant bubble width matches composer
metadata:
  type: feedback
updated: 2026-07-23T19:02:33.652Z
---

- **Assistant Message Bubble Width**: Must match the **Chat Composer** width.
- **User Message Bubble Width**: Must remain narrowed (`max-w-[min(72%,36rem)]`).
- **Implementation Note**: Requires ensuring both components share the same width constraint in the chat layout.