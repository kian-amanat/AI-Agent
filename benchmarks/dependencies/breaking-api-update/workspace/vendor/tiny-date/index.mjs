/** tiny-date v2. `format` was removed in this major version. */
export function formatDate(date, { pattern }) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  return pattern
    .replace("YYYY", d.getUTCFullYear())
    .replace("MM", pad(d.getUTCMonth() + 1))
    .replace("DD", pad(d.getUTCDate()));
}
