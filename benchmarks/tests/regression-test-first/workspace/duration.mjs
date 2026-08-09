/** "1h30m" → total minutes. */
export function parseDuration(s) {
  // BUG: only the first unit is read.
  const m = /(\d+)(h|m)/.exec(String(s ?? ""));
  if (!m) return 0;
  return m[2] === "h" ? Number(m[1]) * 60 : Number(m[1]);
}
