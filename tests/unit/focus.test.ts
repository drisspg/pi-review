import assert from "node:assert/strict";
import test from "node:test";

import { focusReviewHasNoFindings, parseFocusAreas, publishedFocusSection, splitFocusEvidence } from "../../src/focus.js";

test("only an explicit empty result is clean", () => {
  for (const text of ["", "Focus review failed: Model not found", "Pi completed without assistant text.", "- Makefile:12 — Build target fails"]) {
    assert.equal(focusReviewHasNoFindings(text), false, text);
  }
  assert.equal(focusReviewHasNoFindings("No focus areas found."), true);
  assert.equal(focusReviewHasNoFindings("Checked nearby tests. Could not run CUDA locally.No focus areas found."), true);
  assert.equal(focusReviewHasNoFindings("- Makefile:12 — Build target fails\nNo focus areas found."), false);
});

test("focus locations support extensionless files", () => {
  assert.deepEqual(parseFocusAreas("- Makefile:12 — Build target fails\n- .github/CODEOWNERS:4 — Wrong owner").map((area) => area.path), ["Makefile", ".github/CODEOWNERS"]);
});

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
    body: "The helper returns a BlockMask, but lint reports errors at `model.py:281` and `model.py:297`.",
  });
});

test("private verification notes cannot become published by quoting the output format", () => {
  const notes = "Rejected this candidate:\n~~~md\n## Focus areas\n- kernel.py:3 — unsupported caller\n~~~";
  assert.equal(publishedFocusSection(notes), undefined);
  assert.equal(publishedFocusSection(notes + "\n## Focus areas\nNo focus areas found."), "No focus areas found.");
});

test("a proof trace stays in the finding body, not in the list of review locations", () => {
  const trace = "- unrelated.py:1 — a citation, not a finding\nkernel.py:42\n~~~txt\n- old_kernel.py:4 — saved value\n### Evidence\n~~~";
  const body = "Adding one to every score should preserve the gradient; it changes instead.\nCheck against an unchanged-bias control.\n\n### Evidence\n" + trace;
  const areas = parseFocusAreas("### kernel.py:8 — Wrong value gradient\n" + body + "\n### api.ts:4 — Second issue");
  assert.deepEqual(areas.map(area => area.path), ["kernel.py", "api.ts"]);
  assert.equal(areas[0].body, body);
  assert.equal(splitFocusEvidence(body).evidence, trace);
  assert.deepEqual(splitFocusEvidence(trace), { explanation: trace, evidence: "" });
});

test("a legacy citation hidden inside a fence does not renumber saved progress on later findings", () => {
  const areas = parseFocusAreas("- a.py:10 — first\n~~~text\na.py:3 — incidental trace\n~~~\n- a.py:20 — second");
  assert.deepEqual(areas.map(area => area.id), ["a.py:10-10:0", "a.py:20-20:2"]);
});

test("code spans at the end of a title keep their closing backtick", () => {
  const title = "Updating a captured bias doubles `v.grad`";
  const [plain, wrappedPath] = parseFocusAreas("- a.py:1 — " + title + "\nCheck against a control.\n- `b.py:2` — " + title + "\nCheck again.");
  assert.equal(plain.title, title);
  assert.equal(wrappedPath.title, title);
  assert.equal(parseFocusAreas("- __init__.py:1 — Missing export")[0].path, "__init__.py");
});

test("focus parser accepts explicit bullet and numbered location lines", () => {
  const areas = parseFocusAreas(`1. src/a.ts:4-6 — first finding
Details.

- **src/b.py:9 — second finding**
More details.`);

  assert.deepEqual(areas.map(({ path, startLine, endLine, title, body }) => ({ path, startLine, endLine, title, body })), [
    { path: "src/a.ts", startLine: 4, endLine: 6, title: "first finding", body: "Details." },
    { path: "src/b.py", startLine: 9, endLine: 9, title: "second finding", body: "More details." },
  ]);
});

test("focus parser excludes the next numbered finding title from the current body", () => {
  const areas = parseFocusAreas(`1. first finding
- src/a.ts:4 — first finding
  First details.
2. second finding
- src/b.ts:8 — second finding
  Second details.`);

  assert.equal(areas[0].body, "First details.");
  assert.equal(areas[1].body, "Second details.");
});
