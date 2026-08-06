import { scan } from "./dataset.mjs";

/** Returns the record for `key`, or null when there is none. */
export function expensiveLookup(key) {
  return scan((record) => record.key === key);
}
