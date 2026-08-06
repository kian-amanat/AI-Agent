/**
 * Stands in for a slow data source. Every full scan is counted, which is how
 * the cost of a lookup is observed without relying on wall-clock timing.
 */
let scanCount = 0;

export const RECORDS = Array.from({ length: 2000 }, (_, i) => ({
  key: `k${i}`,
  value: i * 3,
}));

export function scan(predicate) {
  scanCount++;
  for (const record of RECORDS) {
    if (predicate(record)) return record;
  }
  return null;
}

export function getScanCount() {
  return scanCount;
}

export function resetScanCount() {
  scanCount = 0;
}
