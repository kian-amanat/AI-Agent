import { formatMoney } from "../lib/money.mjs";

export const CURRENCY = "JPY";

export function renderRefunds(cents) {
  return formatMoney(cents);
}
