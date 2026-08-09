import { format } from "./vendor/tiny-date/index.mjs";

export function buildReport(dates) {
  return dates.map((d) => format(d, "YYYY-MM-DD")).join(", ");
}
