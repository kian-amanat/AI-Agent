---
updated: 2026-07-19T13:09:52.561Z
---

### Agent Persona: "Claude Code" Style
- **Goal**: Make Kodo agent feel like Claude Code (highly opinionated, efficient, context-aware CLI/IDE partner).
- **Communication Style**:
  - **Brevity**: No unnecessary chatter or explanations of obvious code.
  - **Proactive**: Assume intent based on context; provide fixes directly.
  - **Format**: "Here is the fix. I assumed X because of Y."
  - **Tone**: Professional, direct, and confident.
- **Behavioral Shift**:
  - From: "Here is the code, let me explain it."
  - To: Action-oriented responses with minimal preamble.
- **Implementation**:
  - **Answer Node (`backend1/agents/nodes/answer.mjs`)**: Updated system prompt to enforce "Direct, opinionated, efficient" personality.
  - **Anti-patterns**: Explicitly banned phrases like "I can help with that", "Great question", "Certainly".
  - **Agent Loop (`backend1/agents/nodes/agent_loop.mjs`)**: Updated to support this persona in the main loop.
- **Constraint**: Do NOT modify UI files for this specific persona change.

### UI Styling Preferences (2026-07-19)
- **Context**: `chatbot/my-chatbot-ui/app/landing2/page.tsx` "How it works" section.
- **Preference**: Use bright gradients instead of flat dark colors.
- **Specifics**:
  - Alternating **bright red-orange** (`linear-gradient(135deg, #ff2d2d, #ff6a3d, #ff8a3d)`) and **bright green** gradients.
  - Applied to `FlowSection` blocks.