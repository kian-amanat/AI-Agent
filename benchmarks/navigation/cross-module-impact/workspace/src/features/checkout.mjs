import { formatMoney } from "../lib/money.mjs";

export const CURRENCY = "USD";

export function renderCheckout(cents) {
  return formatMoney(cents);
}
