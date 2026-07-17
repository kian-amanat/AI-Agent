---
name: ui-ux-pro
description: Senior-designer rules for premium dark UI — typography scale, whitespace, hierarchy, this project's exact dark-theme values, motion taste. Load for any visual design, layout, or "make it premium" request.
triggers: design, premium, landing, hero, ui, ux, beautiful, modern, restyle, redesign, layout, section, page, marketing
---
## UI/UX PRO RULES (apply all — this is what separates premium from template)

TYPOGRAPHY IS THE DESIGN
- Headlines carry the page: text-5xl → text-7xl/text-8xl on desktop, font-semibold or font-bold, tracking-tight, leading-[1.05].
- Subheads are quiet: text-lg/text-xl, text-white/55–65, max-w-xl/2xl, leading-relaxed. Contrast in SIZE and WEIGHT, not decoration.
- Never decorate text with glows/shadows to make it "premium" — premium type is big, tight, and surrounded by space.

WHITESPACE IS A FEATURE
- Hero: min-h-screen with content vertically centered; py-32/py-40 between sections; gap-6/gap-8 inside groups.
- One idea per section. If a section has more than a headline, one paragraph, and one visual/action row, split it.

HIERARCHY & FOCUS
- Exactly ONE primary CTA per viewport (filled, gradient or brand color). Secondary actions are ghost/text buttons (border-white/10 or plain text-white/60 hover:text-white).
- Eyebrow/badge line above the headline (text-xs uppercase tracking-[0.2em] text-white/40 or a small pill) sets context cheaply.

DARK THEME NUMBERS (this project)
- Page bg #08080a. Surfaces: bg-white/[0.03] with border-white/[0.06] and backdrop-blur. Text: white for headings, white/60 body, white/35 captions.
- Color is an ACCENT: brand orange in one gradient CTA, one text highlight (bg-clip-text), and faint ambient glows (blur-[140px], opacity ≤ 0.15). Never flood sections with tinted backgrounds.

MOTION TASTE
- Entrances: fade-up 12–24px, 0.5–0.7s, ease [0.22, 1, 0.36, 1], staggerChildren 0.08–0.15. Below the fold: whileInView with viewport={{ once: true, margin: "-80px" }}.
- Hover: small (scale 1.02, y -2, shadow bloom). Infinite looping animation on content elements is noise — reserve loops for ambient background only.

STRUCTURE
- Repeated UI = data array + one mapped component. Interactive element = extracted component with typed handlers.
