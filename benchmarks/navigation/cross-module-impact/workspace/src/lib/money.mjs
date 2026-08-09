const SYMBOLS = { USD: "$", EUR: "\u20ac", GBP: "\u00a3", JPY: "\u00a5", CHF: "CHF " };

/** Renders cents as a currency string. */
export function formatMoney(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}
export function symbolFor(code) { return SYMBOLS[code] ?? "$"; }
