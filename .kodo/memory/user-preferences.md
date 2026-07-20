---
name: user-preferences
description: User communication style and UI preferences
metadata:
  type: user
updated: 2026-07-20T20:38:26.898Z
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
- **Preference**: Gradient styling preferences for landing page components.

### Language Preference (2026-07-19)
- **Language**: Persian (Farsi)
- **Scope**: All responses in this session and future sessions should be in Farsi.
- **User Instruction**: "in entire of this session fully speak farsi, i asked english you response to me in farsi"
- **Application**: Respond exclusively in Farsi regardless of the language used in user queries.