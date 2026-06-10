import assert from "node:assert/strict";
import test from "node:test";

import { isGeneratedPath, markGeneratedPullFiles, parseGitattributes } from "../../src/gitattributes.js";

test("gitattributes parses linguist generated rules", () => {
  assert.deepEqual(parseGitattributes(`
# comment
generated/** linguist-generated=true
*.pb.go linguist-generated
generated/keep.pb.go -linguist-generated
*.ts diff=typescript
`), [
    { pattern: "generated/**", generated: true },
    { pattern: "*.pb.go", generated: true },
    { pattern: "generated/keep.pb.go", generated: false },
  ]);
});

test("gitattributes generated matching uses last matching rule", () => {
  const rules = parseGitattributes(`
generated/** linguist-generated=true
*.pb.go linguist-generated
generated/keep.pb.go -linguist-generated
`);

  assert.equal(isGeneratedPath("generated/model.py", rules), true);
  assert.equal(isGeneratedPath("src/schema.pb.go", rules), true);
  assert.equal(isGeneratedPath("generated/keep.pb.go", rules), false);
  assert.equal(isGeneratedPath("src/handwritten.go", rules), false);
});

test("markGeneratedPullFiles tags generated files", () => {
  assert.deepEqual(markGeneratedPullFiles([
    { filename: "generated/model.py", status: "modified", additions: 1, deletions: 0, changes: 1 },
    { filename: "src/main.py", status: "modified", additions: 1, deletions: 0, changes: 1 },
  ], "generated/** linguist-generated=true\n"), [
    { filename: "generated/model.py", status: "modified", additions: 1, deletions: 0, changes: 1, generated: true },
    { filename: "src/main.py", status: "modified", additions: 1, deletions: 0, changes: 1 },
  ]);
});
