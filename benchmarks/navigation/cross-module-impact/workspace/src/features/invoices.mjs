import { formatMoney } from "../lib/money.mjs";

export const CURRENCY = "EUR";

export function renderInvoices(cents) {
  return formatMoney(cents);
}
