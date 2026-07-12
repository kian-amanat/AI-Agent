---
updated: 2026-07-12T09:43:06.125Z
---

- **Success-State Button Design**: `chatbot/my-chatbot-ui/app/components/chat/AssistantMessage.tsx` is the reference implementation for clicked/success button styling.
- The Revert button's success-state classes and feedback content are exported reusable primitives.
- Reuse these primitives for equivalent success states, including Copy and the settings Save Changes button, to preserve animations, colors, transitions, iconography, and spacing.