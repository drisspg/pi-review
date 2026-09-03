import assert from "node:assert/strict";
import test from "node:test";

import { parsePatchRows, parsePatchSetSections, tripleStringStateBefore } from "../../web/src/lib/diff.js";

test("patchset parser unwraps added patch files into inner sections", () => {
  const sections = parsePatchSetSections(`@@ -0,0 +1,12 @@
+# patch overview
+
+diff --git a/foo.py b/foo.py
+new file mode 100644
+index 0000000..1111111
+--- /dev/null
++++ b/foo.py
+@@ -1,2 +1,2 @@
++x = 1
+-old = 0
+ context
+diff --git a/bar.py b/bar.py`);

  assert.deepEqual(sections.map((section) => [section.path, section.title]), [["", "Patch overview"], ["foo.py", "foo.py"], ["bar.py", "bar.py"]]);
  assert.deepEqual(sections[1].rows.map((row) => [row.oldLine, row.newLine, row.targetLine, row.targetSide, row.kind, row.text]), [
    [null, null, 3, "RIGHT", "meta patchset-meta", "diff --git a/foo.py b/foo.py"],
    [null, null, 4, "RIGHT", "meta patchset-meta", "new file mode 100644"],
    [null, null, 5, "RIGHT", "meta patchset-meta", "index 0000000..1111111"],
    [null, null, 6, "RIGHT", "meta patchset-meta", "--- /dev/null"],
    [null, null, 7, "RIGHT", "meta patchset-meta", "+++ b/foo.py"],
    [null, null, 8, "RIGHT", "hunk patchset-hunk", "@@ -1,2 +1,2 @@"],
    [null, 1, 9, "RIGHT", "added", "+x = 1"],
    [1, null, 10, "RIGHT", "removed", "-old = 0"],
    [2, 2, 11, "RIGHT", "context", " context"],
  ]);
});

test("patchset parser recomputes syntax context inside nested diffs", () => {
  const sections = parsePatchSetSections(`@@ -0,0 +1,9 @@
+"""
+outer patch overview text
+diff --git a/foo.py b/foo.py
+--- a/foo.py
++++ b/foo.py
+@@ -1,3 +1,5 @@
++if value is None:
++    return []
+ """inner docstring line`);

  assert.equal(sections[0].rows.find((row) => row.text.includes("if value"))?.syntaxContext, undefined);
  assert.equal(sections[0].rows.find((row) => row.text.includes("return []"))?.syntaxContext, undefined);
  assert.equal(sections[0].rows.find((row) => row.text.includes("inner docstring"))?.syntaxContext, undefined);
});

test("patchset parser resets displayed line numbers for later inner hunks", () => {
  const sections = parsePatchSetSections(`@@ -0,0 +1,12 @@
+diff --git a/foo.py b/foo.py
+--- a/foo.py
++++ b/foo.py
+@@ -77,6 +99,8 @@ def first():
+ keep_old_and_new()
++added_one()
++added_two()
+ keep_after_adds()
+@@ -165,10 +190,41 @@ class Later:
+ context_before()
+-removed_old()
++added_new()
+ context_after()`);

  assert.deepEqual(sections[0].rows.map((row) => [row.oldLine, row.newLine, row.kind, row.text]), [
    [null, null, "meta patchset-meta", "diff --git a/foo.py b/foo.py"],
    [null, null, "meta patchset-meta", "--- a/foo.py"],
    [null, null, "meta patchset-meta", "+++ b/foo.py"],
    [null, null, "hunk patchset-hunk", "@@ -77,6 +99,8 @@ def first():"],
    [77, 99, "context", " keep_old_and_new()"],
    [null, 100, "added", "+added_one()"],
    [null, 101, "added", "+added_two()"],
    [78, 102, "context", " keep_after_adds()"],
    [null, null, "hunk patchset-hunk", "@@ -165,10 +190,41 @@ class Later:"],
    [165, 190, "context", " context_before()"],
    [166, null, "removed", "-removed_old()"],
    [null, 191, "added", "+added_new()"],
    [167, 192, "context", " context_after()"],
  ]);
});

test("patch rows keep the full hunk for inline prompts", () => {
  const rows = parsePatchRows(`@@ -1,3 +1,3 @@
 context
-old
+new
@@ -9 +9 @@
-other
+next`);

  assert.equal(rows.find((row) => row.text === "+new")?.hunk, "@@ -1,3 +1,3 @@\n context\n-old\n+new");
  assert.equal(rows.find((row) => row.text === "+next")?.hunk, "@@ -9 +9 @@\n-other\n+next");
});

test("patchset parser ignores ordinary patches", () => {
  assert.deepEqual(parsePatchSetSections(`@@ -1 +1 @@
-old
+new`), []);
});

test("patch rows seed the docstring state at a hunk that starts mid-docstring", () => {
  const newText = ["def f():", '    """', "    Given an expr with a single symbol.", '    """', "    if x:", "        return None", ""].join("\n");
  const patch = ["@@ -3,4 +3,4 @@ def f():", "     Given an expr with a single symbol.", '     """', "-    if x:", "+    if not x:", "         return None"].join("\n");
  const unseeded = parsePatchRows(patch);
  assert.equal(unseeded.find((row) => row.text.includes("Given an expr"))?.syntaxContext, undefined, "without file text the parser cannot know it is inside a docstring");

  const rows = parsePatchRows(patch, { newText, oldText: newText.replace("if not x", "if x") });
  assert.equal(rows.find((row) => row.text.includes("Given an expr"))?.syntaxContext, "string");
  assert.equal(rows.find((row) => row.text.includes('"""'))?.syntaxContext, "string", "the closing quotes still render as string");
  assert.equal(rows.find((row) => row.text.includes("if not x"))?.syntaxContext, undefined);
  assert.equal(rows.find((row) => row.text.includes("return None"))?.syntaxContext, undefined);
  assert.equal(tripleStringStateBefore(newText, 3), '"""');
  assert.equal(tripleStringStateBefore(newText, 5), null);
  assert.equal(tripleStringStateBefore(null, 3), null);
});
