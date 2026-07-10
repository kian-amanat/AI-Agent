---
updated: 2026-07-08T23:10:29.373Z
---

- **Send Button Behavior**: Disabled when input length is 0. Exception: Enabled when AI is responding (`isSending` is true) to allow aborting the stream.
- **Code Change Preference**: Prefers minimal changes, specifically requesting to "just add this feature, and don't change any part of the code" beyond the necessary addition.
- **UI Style Preference**: Prefers a "Claude Code" aesthetic for empty states, including specific animations and color consistency.
- **Copy Button Preference**: Wants copy buttons on **all** message bubbles (user and AI) to copy text to clipboard. Previous detail for user messages (underneath/right-aligned) remains relevant.
- **Active Theme Colors**: Primary accent color set to `#ff6b2b` in `ChatComposer.tsx`.
- **Chat Sidebar Behavior**: Collapsed state displays orange `Plus` icon (`#ff6b2b`) with no background. Hover transitions smoothly from `icon.png` to right arrow.
- **ChatHeader Design**: Minimal layout: sidebar toggle on the left only, flat dark background, thin bottom border.
