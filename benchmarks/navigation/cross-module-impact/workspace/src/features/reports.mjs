import { formatMoney } from "../lib/money.mjs";

export const CURRENCY = "CHF";

export function renderReports(cents) {
  return formatMoney(cents);
}
