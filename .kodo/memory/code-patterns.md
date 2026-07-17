---
updated: 2026-07-17T13:45:50.714Z
---

### Workflow Component Reuse Pattern (2026-07-17)
- **Context**: Replaced simple 'How it Works' section with complex workflow visualization.
- **File**: `chatbot/my-chatbot-ui/app/landing2/page.tsx`
- **Strategy**: Full file replacement to integrate `n8n-workflow-block-shadcnui` (or similar uploaded workflow component).
- **Key Constraints**:
  - Do NOT redesign from scratch.
  - Reuse existing component's: canvas layout, node positioning, animated SVG lines, node interactions, Framer Motion animations, responsive behavior, drag system, and connection rendering.
  - Only adapt visual style to Kodo's brand (warm dark, orange-red).
- **Pattern**: When upgrading complex UI sections, prefer full-file replacement if the diff is too large for patches, ensuring all existing structural imports (Navbar, Footer) are preserved.

### Hero Refinement Pattern (2026-07-17)
- **Context**: Refining `GlowHorizon` hero for premium SaaS look without full redesign.
- **File**: `chatbot/my-chatbot-ui/app/landing2/page.tsx`
- **Strategy**: Full file update to adjust visual hierarchy, typography, and spacing while keeping background and core layout intact.
- **Specific Adjustment**: Move entire hero content slightly upward so the glow frames the CTA area, not the paragraph text.
- **Constraint**: Keep existing orange-red Glow Horizon background, navbar, buttons, and overall dark Kodo style.