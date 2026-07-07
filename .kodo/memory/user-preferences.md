---
updated: 2026-07-07T21:50:20.040Z
---

- **Send Button Behavior**: 
  - Disabled when input length is 0 (no characters).
  - **Exception**: Enabled when AI is responding (`isSending` is true) to allow aborting the stream.
  - This ensures the user can stop generation even if the input field is empty (e.g., after a previous message).
- **Code Change Preference**: User prefers minimal changes, specifically requesting to "just add this feature, and don't change any part of the code" beyond the necessary feature addition.
- **UI Style Preference**: User prefers a "Claude Code" aesthetic for empty states, including specific animations and color consistency with the rest of the app.
- **UI Layout Preference**: User prefers copy buttons for user messages to be placed **underneath** the bubble and aligned to the **right** side.
- **Active Theme Colors**: 
  - Primary accent color set to `#ff6b2b` (updated from `#ff8a3d`) in `ChatComposer.tsx`.
- **Chat Sidebar Behavior**: 
  - **Collapsed State**: Displays a `Plus` icon with orange color (`#ff6b2b`) and no background.
  - **Hover Interaction**: Smoothly transitions (fade/slide) from `icon.png` to a right arrow (`KeyboardDoubleArrowLeft`)
  - **Icon Layout**: Search icon is positioned **above** the plus icon.
  - **Icon Sizing**: Plus icon background is kept small/refined.
