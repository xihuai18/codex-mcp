import assert from "node:assert/strict";
import test from "node:test";

import { clamp, mean } from "../src/math.js";

test("mean computes average for a list", () => {
  assert.equal(mean([1, 2, 3]), 2);
});

test("mean returns the number for a singleton", () => {
  assert.equal(mean([10]), 10);
});

test("clamp bounds a value", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
});

