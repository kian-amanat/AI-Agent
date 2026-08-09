// Legacy. Nothing imports this.
export const CURRENCY_SYMBOLS = { USD: "$", EUR: "\u20ac" };
export function getSymbol(c) { return CURRENCY_SYMBOLS[c] ?? "$"; }
