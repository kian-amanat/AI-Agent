---
updated: 2026-07-16T09:59:53.381Z
---

### Apple-Style Horizontal Storytelling Pattern
- **Concept**: Vertical scroll drives horizontal movement of feature cards.
- **Technique**: 
  - Use `useScroll` on a container with `sticky` positioning.
  - Use `useTransform` to map vertical scroll progress to horizontal X translation.
  - Cards move horizontally across the screen as user scrolls down.
- **Visual Style**:
  - **Immersive Full-Screen Cards**: Cards are sized 85–90vw width and 80–90vh height on desktop.
  - **Generous Padding**: Internal padding of 40–64px for breathing room.
  - **Typography**: Large typography with strong visual hierarchy.
  - **Icons**: Proportionally large icons and illustrations.
  - Glassmorphism design for cards.
  - Smooth entrance animations.
  - Subtle scale/opacity changes based on scroll progress (parallax-like depth).
  - **Shadows**: Rich orange-red ambient shadows with soft glowing depth and subtle red-orange light bleeding outward.
- **Tech Stack**:
  - Framer Motion (`useScroll`, `useTransform`, `motion.div`).
  - CSS `sticky` positioning for the pinning effect.
- **Constraint**: Do not use external libraries beyond Framer Motion for this e
- **Interaction Note**: User requested removing backdrop on hover for specific text elements in the hero section (applied to `backend1/agents/kodo_graph.mjs` via structured plan fallback).