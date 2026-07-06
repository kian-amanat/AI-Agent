---
updated: 2026-07-06T18:35:52.564Z
---

- **Send Button Behavior**: 
  - Disabled when input length is 0 (no characters).
  - **Exception**: Enabled when AI is responding (`isSending` is true) to allow aborting the stream.
  - This ensures the user can stop generation even if the input field is empty (e.g., after a previous message).
- **Code Change Preference**: User prefers minimal changes, specifically requesting to "just add this feature, and don't change any part of the code" beyond the necessary feature addition.
- **UI Style Preference**: User prefers a "Claude Code" aesthetic for empty states, including specific animations and color consistency with the rest of the app.
- **UI Layout Preference**: User prefers copy buttons for user messages to be placed **underneath** the bubble and aligned to the **right** side.
