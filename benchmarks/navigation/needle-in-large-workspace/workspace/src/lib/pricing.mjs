import { symbolFor } from "./internal/fmt/currency.mjs";

export function formatPrice(order) {
  return `${symbolFor(order.currency)}${order.amount.toFixed(2)}`;
}
