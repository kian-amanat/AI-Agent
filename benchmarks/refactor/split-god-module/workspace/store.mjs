// Everything ended up here. Four unrelated concerns in one file.

export function cartSubtotal(items) {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}
export function applyDiscount(subtotal, percent) {
  const off = subtotal * (percent / 100);
  return Math.max(0, Math.round((subtotal - off) * 100) / 100);
}
export function cartTotal(items, percent = 0) {
  return applyDiscount(cartSubtotal(items), percent);
}

export function displayName(user) {
  const first = (user?.first ?? "").trim();
  const last = (user?.last ?? "").trim();
  if (!first && !last) return "Anonymous";
  return last ? `${first} ${last}`.trim() : first;
}
export function initials(user) {
  const n = displayName(user);
  if (n === "Anonymous") return "??";
  return n.split(/\s+/).map((p) => p[0].toUpperCase()).join("");
}

export function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}
export function daysInMonth(y, m) {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

export function isValidEmail(s) {
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(String(s ?? ""));
}
export function isValidQty(n) {
  return Number.isInteger(n) && n > 0 && n <= 999;
}
