import assert from "node:assert/strict";
import test from "node:test";

import { prUrlForNumber } from "../../web/src/lib/pr.js";

test("builds a same-repository pull request URL", () => {
  assert.equal(prUrlForNumber("https://github.com/pytorch/pytorch/pull/189805", 189841), "https://github.com/pytorch/pytorch/pull/189841");
});

test("rejects non-pull-request URLs", () => {
  assert.equal(prUrlForNumber("https://github.com/pytorch/pytorch/issues/189805", 189841), null);
});
