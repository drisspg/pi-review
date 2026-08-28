import assert from "node:assert/strict";
import test from "node:test";

import { parseOverviewSections } from "../../web/src/lib/overview.js";

test("parses structured overview sections with a preamble folded into the TL;DR", () => {
  const sections = parseOverviewSections("Intro line.\n## TL;DR\nGoal and idea.\n## Schematic\n```mermaid\nflowchart LR\n  A --> B\n```\n## Change map\n- `src/a.ts` — core behavior\n## Reviewer notes\n- start at src/a.ts:4");

  assert.notEqual(sections, null);
  assert.equal(sections?.tldr, "Intro line.\n\nGoal and idea.");
  assert.match(sections?.schematic ?? "", /flowchart LR/);
  assert.match(sections?.changeMap ?? "", /core behavior/);
  assert.match(sections?.notes ?? "", /start at src\/a\.ts:4/);
});

test("returns null for legacy free-form overviews", () => {
  assert.equal(parseOverviewSections("# PR goal\n\nOrient reviewers.\n\n## Walk map\n\n```mermaid\nflowchart LR\n  A --> B\n```"), null);
});

test("tolerates unknown sections and missing optional panels", () => {
  const sections = parseOverviewSections("## TL;DR\nGoal.\n## Schematic\ndiagram\n## Something else\nignored");

  assert.equal(sections?.tldr, "Goal.");
  assert.equal(sections?.schematic, "diagram");
  assert.equal(sections?.changeMap, "");
  assert.equal(sections?.notes, "");
});
