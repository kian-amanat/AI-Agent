---
name: framer-motion-patterns
description: Known-good framer-motion code recipes for this project — staggered entrances, scroll-jacking, scroll progress bars, 3D cursor tilt, self-drawing lines, ambient glows, spring/easing tokens. Load for ANY animation or motion work.
triggers: animation, animate, motion, scroll, stagger, parallax, hover, transition, reveal, tilt, 3d, spring, framer
---
## FRAMER MOTION RECIPES (use these exact patterns — they are known-good in this project)

STAGGERED ENTRANCE (hero, card grids)
```tsx
const container = { hidden: {}, visible: { transition: { staggerChildren: 0.12, delayChildren: 0.1 } } };
const item = { hidden: { opacity: 0, y: 18 }, visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] } } };
<motion.div variants={container} initial="hidden" animate="visible">
  <motion.h1 variants={item}>…</motion.h1>
  <motion.p variants={item}>…</motion.p>
</motion.div>
```
Below the fold: replace animate="visible" with whileInView="visible" viewport={{ once: true, margin: "-80px" }}.

SCROLL-JACKING (vertical scroll drives horizontal row) — the wrapper drives, never per-card:
```tsx
const wrapperRef = useRef<HTMLDivElement>(null);
const { scrollYProgress } = useScroll({ target: wrapperRef });
const x = useTransform(scrollYProgress, [0, 1], ["0%", "-60%"]);
<div ref={wrapperRef} className="relative h-[300vh]">
  <div className="sticky top-0 flex h-screen items-center overflow-hidden">
    <motion.div style={{ x }} className="flex gap-8 pl-[10vw]">{cards}</motion.div>
  </div>
</div>
```

SCROLL PROGRESS BAR
```tsx
const { scrollYProgress } = useScroll();
const scaleX = useSpring(scrollYProgress, { stiffness: 120, damping: 30 });
<motion.div style={{ scaleX }} className="fixed top-0 inset-x-0 h-1 origin-left z-[60] bg-gradient-to-r from-[#ff5e4d] to-[#ffa03d]" />
```

3D TILT TOWARD CURSOR (typed handler — required)
```tsx
const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
  const r = e.currentTarget.getBoundingClientRect();
  const rx = -((e.clientY - r.top) / r.height - 0.5) * 10;
  const ry = ((e.clientX - r.left) / r.width - 0.5) * 10;
  e.currentTarget.style.transform = `perspective(1000px) rotateX(${rx}deg) rotateY(${ry}deg)`;
};
const onLeave = (e: React.PointerEvent<HTMLDivElement>) => { e.currentTarget.style.transform = ""; };
```

SELF-DRAWING LINE (timelines, connectors)
```tsx
<motion.div initial={{ scaleY: 0 }} whileInView={{ scaleY: 1 }} viewport={{ once: true }}
  transition={{ duration: 1.2, ease: "easeInOut" }} className="origin-top w-px bg-gradient-to-b from-[#ff8a3d] to-transparent" />
```

AMBIENT BREATHING GLOW (background only, never content)
```tsx
<motion.div animate={{ scale: [1, 1.12, 1], opacity: [0.08, 0.14, 0.08] }}
  transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }}
  className="pointer-events-none absolute -top-40 -left-40 h-[560px] w-[560px] rounded-full bg-[#ff5e4d] blur-[160px]" />
```

TOKENS: ease [0.22, 1, 0.36, 1] · spring { stiffness: 300–420, damping: 22–30 } · durations 0.4–0.7s content, 6–10s ambient.
