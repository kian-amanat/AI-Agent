---
name: project-composer-redesign
description: Redesigning chat composer to match Claude Code desktop app
metadata:
  type: project
updated: 2026-07-24T21:31:08.144Z
---

- **Goal**: Redesign the chat composer to closely match the desktop Claude Code application (minimal, compact, developer-focused).
- **Specific Requirement**: Separate all git features into an input and move them to the top of the input area.
- **Current State**: ChatComposer.tsx (1118 lines) contains file attachment, voice recording, text input, and scattered git feature pills (Branch, Commit, Push, PR).
- **Status**: Initial analysis complete; no files edited yet.