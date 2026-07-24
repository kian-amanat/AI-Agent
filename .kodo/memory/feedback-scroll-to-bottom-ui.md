---
name: feedback-scroll-to-bottom-ui
description: UI preference: scroll-to-bottom button centered above composer
metadata:
  type: project
updated: 2026-07-23T22:36:58.803Z
---

- **Rule**: The "Scroll to Bottom" arrow button must be positioned **centered above the chat composer**, similar to ChatGPT's behavior.
- **Implementation**: Move the button from its current absolute bottom-right position (`bottom-4 right-4`) into the layout flow directly above the `ChatComposer` component, applying centering styles.
- **Reason**: Matches user's expected UX pattern for chat interfaces (ChatGPT style) rather than the previous floating corner button approach.
- **Note**: This replaces the previous positioning logic in `app/page.tsx`.