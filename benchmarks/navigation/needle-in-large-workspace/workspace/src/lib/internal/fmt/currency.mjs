const SYMBOLS = { USD: "$", EUR: "\u20ac", GBP: "\u00a3", JPY: "\u00a5" };

/** Returns the display symbol for an ISO currency code. */
export function symbolFor(currency) {
  // BUG: the argument is ignored.
  return SYMBOLS.USD;
}
