import assert from "node:assert/strict";
import test from "node:test";

import { parseFocusAreas } from "../../web/src/lib/focus.js";

test("focus parser ignores incidental file references in finding prose", () => {
  const areas = parseFocusAreas(`## Focus areas

- \`torchtitan/models/common/decoder.py:292 — Helper return type breaks its intended API contract\`  
  The helper returns a BlockMask, but lint reports errors at \`model.py:281\` and \`model.py:297\`.
`);

  assert.equal(areas.length, 1);
  assert.deepEqual(areas[0], {
    id: "torchtitan/models/common/decoder.py:292-292:0",
    path: "torchtitan/models/common/decoder.py",
    startLine: 292,
    endLine: 292,
    title: "Helper return type breaks its intended API contract",
    body: "- `torchtitan/models/common/decoder.py:292 — Helper return type breaks its intended API contract`  \n  The helper returns a BlockMask, but lint reports errors at `model.py:281` and `model.py:297`.",
  });
});

test("focus parser accepts explicit bullet and numbered location lines", () => {
  const areas = parseFocusAreas(`1. src/a.ts:4-6 — first finding
Details.

- **src/b.py:9 — second finding**
More details.`);

  assert.deepEqual(areas.map(({ path, startLine, endLine, title }) => ({ path, startLine, endLine, title })), [
    { path: "src/a.ts", startLine: 4, endLine: 6, title: "first finding" },
    { path: "src/b.py", startLine: 9, endLine: 9, title: "second finding" },
  ]);
});
