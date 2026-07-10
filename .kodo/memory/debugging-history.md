---
updated: 2026-07-10T21:02:07.207Z
---

- **Bug**: Font not applied in chat UI.
- **Root Cause**: Hardcoded `Arial` font-family in `body` rule of `globals.css` was overriding the Tailwind theme variable.
- **Fixes**:
  - Replaced hardcoded font with Tailwind theme variable to apply Geist font.
  - Updated `globals.css` `@theme` block to include fallback font stacks for `--font-sans` and `--font-mono` to ensure reliable cross-browser application.
- **Bug**: Broken Tailwind class `font-['Space Grotesk',sans-serif]` in `ChatSidebar.tsx`.
- **Root Cause**: Unescaped space inside the arbitrary value breaks Tailwind's class parser, preventing font-family rule generation.
- **Fix**: Replaced inline arbitrary value with `font-space-grotesk` utility (mapped to `--font-space-grotesk` theme token).
- **Bug**: Naming collision between Next.js `next/font` injected variable and Tailwind theme token (`--font-space-grotesk`).
- **Root Cause**: Self-referential loop / conflict when both use the same CSS variable name.
- **Fix**: Renamed Next.js injected variable to `--font-space-grotesk-sans` in `layout.tsx` and updated `globals.css` `@theme` token to reference the renamed variable.