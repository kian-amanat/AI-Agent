/**
 * app/lib/commandPalette.ts
 *
 * The command palette's decision logic, with no React and no DOM in it.
 *
 * WHY IT IS SEPARATE
 * Matching, ranking and cursor movement are the parts that actually break, and
 * they are the parts that are hardest to check from inside a component — proving
 * "Ctrl+K opens the palette" through a rendered tree needs a browser and a test
 * runner, neither of which this app has. Pulled out here they are ordinary
 * functions over plain values, so they can be tested directly with `node` and
 * the TypeScript compiler the project already depends on.
 *
 * Everything below is pure: same input, same output, no state.
 */

/** The shape the palette needs in order to match and rank. */
export type PaletteItem = {
  key:       string;
  label:     string;          // "/deploy"
  group:     string;
  disabled?: boolean;
};

/** The subset of a keyboard event this module needs — so tests need no DOM. */
export type ShortcutEvent = {
  key:      string;
  metaKey?:  boolean;
  ctrlKey?:  boolean;
  altKey?:   boolean;
  shiftKey?: boolean;
};

/**
 * Cmd+K on macOS, Ctrl+K elsewhere.
 *
 * Both are accepted on every platform rather than sniffing the user agent:
 * an external keyboard on a Mac, or a Mac user on a Linux box, should not have
 * to think about it. Alt is rejected because Ctrl+Alt+K is a distinct chord
 * that belongs to the OS or the browser, and swallowing it would be rude.
 * Shift is likewise rejected so Ctrl+Shift+K (the browser console) still works.
 */
export function isPaletteShortcut(e: ShortcutEvent): boolean {
  if (e.key?.toLowerCase() !== "k") return false;
  if (e.altKey || e.shiftKey) return false;
  return Boolean(e.metaKey || e.ctrlKey);
}

/** Escape closes the palette — the one key that must always get you out. */
export function isDismissKey(e: ShortcutEvent): boolean {
  return e.key === "Escape";
}

/**
 * Fuzzy match: are the query's characters present, in order, in the label?
 *
 * Returns a score where HIGHER is better, or `null` for no match. The scoring
 * exists so that "cm" puts /commands above /compact — a plain subsequence test
 * matches both equally and then the ordering is whatever the array happened to
 * be, which feels random to use.
 *
 * Three things earn points, in descending weight:
 *   - a prefix match             — what the user most often means
 *   - consecutive runs           — "comm" in /commands beats scattered hits
 *   - matching at a word start   — after a "-", "_", ":" or "/"
 * Shorter labels break ties, so the most specific command wins.
 */
export function fuzzyScore(label: string, query: string): number | null {
  const l = label.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 1;                    // no query — everything matches equally

  let li = 0;
  let score = 0;
  let run = 0;

  for (const ch of q) {
    const found = l.indexOf(ch, li);
    if (found === -1) return null;     // a character missing entirely — no match

    if (found === li && li > 0) {
      run += 1;
      score += 8 + run * 2;            // consecutive characters compound
    } else {
      run = 0;
      const prev = found > 0 ? l[found - 1] : "";
      if (found === 0 || prev === "/" || prev === "-" || prev === "_" || prev === ":") score += 6;
    }
    score += 1;
    li = found + 1;
  }

  // A true prefix (ignoring the leading slash) is almost always the intent.
  if (l.replace(/^\//, "").startsWith(q.replace(/^\//, ""))) score += 40;

  // Prefer the shorter of two otherwise-equal matches.
  score -= l.length * 0.1;
  return score;
}

/**
 * Filter and rank a command list against a query.
 *
 * Ordering is deliberate: ranked strictly by score, and only within an equal
 * score does the original list order survive. Grouping is a presentation
 * concern and is applied after this, so a search never hides a good match just
 * because its group sorts late.
 *
 * A leading "/" is optional — the composer passes "/co" and the modal passes
 * "co", and both should behave identically.
 */
export function filterCommands<T extends PaletteItem>(items: readonly T[], query: string): T[] {
  const q = query.replace(/^\//, "").trim();
  if (!q) return [...items];

  const scored: { item: T; score: number; idx: number }[] = [];
  items.forEach((item, idx) => {
    const score = fuzzyScore(item.label, q);
    if (score !== null) scored.push({ item, score, idx });
  });

  scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
  return scored.map((s) => s.item);
}

/**
 * Move the highlight, wrapping at both ends.
 *
 * Wrapping matters more than it looks: with a list this short, arrowing off the
 * bottom and stopping dead feels broken. An empty list pins the index at 0 so
 * callers never have to special-case it.
 */
export function moveSelection(current: number, length: number, delta: number): number {
  if (length <= 0) return 0;
  return (((current + delta) % length) + length) % length;
}

/**
 * The item a keypress or click should act on — or `null` if there isn't one.
 *
 * Disabled entries resolve to `null` rather than being skipped over, so a
 * command that is present-but-unavailable still shows why it cannot be used
 * instead of silently vanishing from the keyboard path.
 */
export function resolveSelection<T extends PaletteItem>(items: readonly T[], index: number): T | null {
  const item = items[index];
  if (!item || item.disabled) return null;
  return item;
}
