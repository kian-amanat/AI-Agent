---
name: project-chat-composer-redesign
description: Redesign ChatComposer to match Claude Code desktop app style
metadata:
  type: project
updated: 2026-07-24T21:51:53.271Z
---

- **Goal**: Redesign the ChatComposer to closely match the desktop Claude Code application while preserving existing functionality.
- **Design Principles**: Minimal, compact, developer-focused, optimized for coding workflows.
- **Specific Requirement**: Separate all git features (status, branch switching, commit/push) from the input area and move them to the top of the input component.
- **Status**: In progress. Initial analysis of ChatComposer.tsx (1119 lines) completed to understand structure including git polling, file attachments, voice, slash commands, and @-mentions.
