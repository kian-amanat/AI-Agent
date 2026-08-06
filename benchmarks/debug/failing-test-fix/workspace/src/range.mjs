/** Inclusive of `start`, exclusive of `end`. */
export function range(start, end) {
  const out = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}

export function sumRange(start, end) {
  return range(start, end).reduce((a, b) => a + b, 0);
}
