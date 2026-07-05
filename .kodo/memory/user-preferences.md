---
updated: 2026-07-05T15:54:26.157Z
---

- Always generate modular code
- Prefers minimal UI interactions; specifically requested removing rotation animations on hover for settings icons to keep them subtle
- **Hover Design Preference**: For the settings button, prefers "better" hover animations/design but strictly **minimal** (subtle, not flashy). Avoids aggressive transforms like rotation.
- **Color Preference**: Recent update specifies "excited" red-orange color for settings button hover state.
- **Icon Styling Preference**: Remove shadows from icons; use colorful hover states (specifically 70% orange, 30% red) for visual feedback.
- **UI Interaction Preference**: Requests hover-revealed copy buttons for user message bubbles in chat interfaces.
- **Loading State Preference**: In ChatComposer, prefers using a specific icon (`StopRoundedIcon`) with white color for the send button during loading states, rather than a generic loading spinner/button.
- **Settings Icon Hover**: Explicitly requested removal of `whileHover={{ scale: 1.08 }}` on the settings icon to eliminate size increase on hover.
- **Send Button Behavior**: The send button should never be disabled. It should toggle between Send and Stop/Abort actions based on agent state.