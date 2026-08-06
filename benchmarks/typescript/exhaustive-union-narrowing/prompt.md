`area.ts` uses `any` and does not handle every `Shape` variant.

Rewrite it to be fully type-safe: narrow on the discriminant, handle every variant, and make it a **compile-time error** if a new variant is ever added to `Shape` without updating `area`. Do not use `any`.
