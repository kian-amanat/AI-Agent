import { area } from "./area";
import type { Shape } from "./types";

const shapes: Shape[] = [
  { kind: "circle", radius: 2 },
  { kind: "square", size: 3 },
  { kind: "rectangle", width: 2, height: 5 },
];

export const total = shapes.reduce((sum, s) => sum + area(s), 0);
