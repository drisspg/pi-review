import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewVisual } from "../../src/review-visual.js";

test("visual lanes preserve readable labels and step values across clipboard line endings", () => {
  assert.deepEqual(parseReviewVisual("Base: x: 1 → 2\r\nHEAD: x: 1 → 3"), [
    { label: "Base", steps: ["x: 1", "2"] }, { label: "HEAD", steps: ["x: 1", "3"] },
  ]);
  for (const lane of ["Base: no transition", "Base: 1 -> 2", "Base: 1 → 2 → 3 → 4 → 5", "Base: → 2"]) {
    assert.equal(parseReviewVisual(lane + "\nHEAD: 1 → 2"), null);
  }
});
