---
name: landing-hero-recipes
triggers: hero, landing, openai, linear, vercel, stripe, marketing, headline, cta, restyle, feel like, look like
---
## HERO ARCHETYPES (pick the ONE that matches the requested reference; adapt colors to this project's palette)

### 1. OPENAI-MINIMAL — "feel like openai.com"
The OpenAI look is NOT effects. It is: enormous type, extreme whitespace, near-zero chrome, one quiet action row. Adding glows/gradient washes makes it LESS like OpenAI.
```tsx
<section className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
  <motion.h1 variants={item} className="max-w-5xl text-6xl md:text-8xl font-semibold tracking-tight leading-[1.02] text-white">
    {headline}
  </motion.h1>
  <motion.p variants={item} className="mt-8 max-w-2xl text-lg md:text-xl text-white/55 leading-relaxed">
    {subheadline}
  </motion.p>
  <motion.div variants={item} className="mt-12 flex items-center gap-4">
    <a className="rounded-full bg-white px-6 py-3 text-sm font-medium text-black transition hover:bg-white/90">{primaryCta}</a>
    <a className="rounded-full px-6 py-3 text-sm font-medium text-white/70 transition hover:text-white">Learn more {'>'}</a>
  </motion.div>
</section>
```
Adapt to Kodo: keep the structure and scale EXACTLY; the only brand touches allowed are (a) primary button may use the orange gradient instead of white, (b) ONE faint ambient glow far behind (opacity ≤ 0.1). Nothing else glows.

### 2. LINEAR-GLOW — "feel like linear.app"
Dark, one strong gradient beam behind the headline, glass surfaces, gradient text highlight.
Key pieces: radial beam div behind content (bg-[radial-gradient(ellipse_at_top,rgba(255,110,60,0.22),transparent_60%)]), headline with a bg-clip-text gradient span, glass pill badge above (border-white/10 bg-white/[0.04] backdrop-blur), CTA with soft glow shadow.

### 3. VERCEL-GRID — "feel like vercel.com"
Near-black bg, subtle grid lines (bg-[linear-gradient(rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[size:56px_56px]), massive gradient headline (bg-clip-text across the full headline), tight monochrome buttons (one white-filled, one bordered).

RULES FOR ALL ARCHETYPES
- Copy is verbatim from the existing page/user — restyling never rewrites words.
- Structure replaces decoration: when asked to "feel like" a site, change LAYOUT, TYPE SCALE, and SPACING first; effects last.
- The navbar and other sections keep working; only touch what the request names.
