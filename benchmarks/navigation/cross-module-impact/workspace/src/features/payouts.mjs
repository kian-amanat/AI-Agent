import { formatMoney } from "../lib/money.mjs";

export const CURRENCY = "GBP";

export function renderPayouts(cents) {
  return formatMoney(cents);
}
