---
updated: 2026-07-13T20:17:43.524Z
---

### Motion Component Patterns
- Local class utility (cn):
  ```ts
  const cn = (...classes: (string | undefined | false)[]) => classes.filter(Boolean).join(" ");
  ```
- GSAP Integration: Use directly without additional imports (already available)
- Component Imports: Prefer relative paths for local components (e.g., `./magnetic-button` vs absolute paths)
- **New Pattern**: Avoid direct `style` property manipulation on motion components - use animation props instead
- **New Pattern**: Ensure transition objects match expected type structure:
  ```ts
  transition: { duration: number, ease: string }
  ```
- **Best Practice**: Use `animate`/`initial` props for state-driven animations rather than direct DOM manipulation