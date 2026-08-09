import test from "node:test";
import assert from "node:assert";
import { parseDuration } from "./duration.mjs";

test("parses hours", () => { assert.strictEqual(parseDuration("2h"), 120); });
test("parses minutes", () => { assert.strictEqual(parseDuration("45m"), 45); });
test("empty input is zero", () => { assert.strictEqual(parseDuration(""), 0); });
