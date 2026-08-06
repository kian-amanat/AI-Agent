import test from "node:test";
import assert from "node:assert";
import { range, sumRange } from "../src/range.mjs";

test("range is exclusive of end", () => {
  assert.deepStrictEqual(range(0, 3), [0, 1, 2]);
});

test("range of an empty span is empty", () => {
  assert.deepStrictEqual(range(2, 2), []);
});

test("sumRange sums the exclusive range", () => {
  assert.strictEqual(sumRange(1, 5), 10);
});
