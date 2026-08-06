import type { Shape } from "./types";

// FIXME: untyped, and it silently returns 0 for anything it doesn't know about.
export function area(shape: any): number {
  if (shape.kind === "circle") return Math.PI * shape.radius * shape.radius;
  if (shape.kind === "square") return shape.size * shape.size;
  return 0;
}
