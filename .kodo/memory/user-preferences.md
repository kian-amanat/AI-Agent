---
updated: 2026-07-12T15:53:41.255Z
---

- Send Button Behavior: Disabled when input length is 0. Exception: Enabled when AI is responding (`isSending` is true) to allow aborting the stream.
- Code Change Preference: Prefers minimal changes, specifically requesting to "just add this feature, and don't change any part of the code" beyond the necessary addition.
- UI Style Preference:
  - Prefers a "Claude Code" aesthetic for empty states
  - Settings page saved-state button uses: `border border-emerald-400/80 bg-emerald-400/10 text-emerald-50 shadow-[0_0_18px_rgba(16,185,129,0.25)]`
- Copy Button Preference: Wants copy buttons on all message bubbles (user and AI)
- Active Theme Colors: Primary accent set to `#ff6b2b` in `ChatComposer.tsx`
- Chat Sidebar Behavior: Collapsed shows orange `Plus` icon
- ChatSidebar Height: Reduced to `h-[calc(100vh-6rem)]`
- Chat Sidebar Box Shadow: Reduced to a slightly lower intensity for subtle elevation
- Tooltip Usage: Expects tooltips on interactive elements like buttons for clarity; e.g., added `title="Save your model configuration"` to the Save Changes button in settings.