---
updated: 2026-07-10T21:20:12.708Z
---

- **Send Button Behavior**: Disabled when input length is 0. Exception: Enabled when AI is responding (`isSending` is true) to allow aborting the stream.
- **Code Change Preference**: Prefers minimal changes, specifically requesting to "just add this feature, and don't change any part of the code" beyond the necessary addition.
- **UI Style Preference**: Prefers a "Claude Code" aesthetic for empty states, including specific animations and color consistency.
- **Copy Button Preference**: Wants copy buttons on **all** message bubbles (user and AI) to copy text to clipboard. Previous detail for user messages (underneath/right-aligned) remains relevant.
- **Active Theme Colors**: Primary accent color set to `#ff6b2b` in `ChatComposer.tsx`.
- **Chat Sidebar Behavior**: Collapsed state displays orange `Plus` icon (`#ff6b2b`) with no background. Hover transitions smoothly from `icon.png` to right arrow.
- **ChatSidebar Styling**: Added a pronounced 3D box-shadow Tailwind class to the root `motion.aside` element to enhance depth.
- **ChatSidebar Height**: Reduced from `h-[calc(100vh-2rem)]` to `h-[calc(100vh-6rem)]` in `ChatSidebar.tsx`.
- **Session Title Compact Mode**: Passes `compactTitles={true}` to `<ChatSidebar>` in `app/page.tsx` to reduce the height of individual session title fields.