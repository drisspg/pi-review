import assert from "node:assert/strict";
import test from "node:test";

import { parsePatchSetSections } from "../../web/src/lib/diff.js";

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

test("patchset parser ignores ordinary patches", () => {
  assert.deepEqual(parsePatchSetSections(`@@ -1 +1 @@
-old
+new`), []);
});
