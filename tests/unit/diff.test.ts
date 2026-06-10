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
+@@ -0,0 +1,2 @@
++x = 1
+-old = 0
+ context
+diff --git a/bar.py b/bar.py`);

  assert.deepEqual(sections.map((section) => section.title), ["Patch overview", "foo.py", "bar.py"]);
  assert.deepEqual(sections[1].rows.map((row) => [row.newLine, row.kind, row.text]), [
    [3, "meta patchset-meta", "diff --git a/foo.py b/foo.py"],
    [4, "meta patchset-meta", "new file mode 100644"],
    [5, "meta patchset-meta", "index 0000000..1111111"],
    [6, "meta patchset-meta", "--- /dev/null"],
    [7, "meta patchset-meta", "+++ b/foo.py"],
    [8, "hunk patchset-hunk", "@@ -0,0 +1,2 @@"],
    [9, "added", "+x = 1"],
    [10, "removed", "-old = 0"],
    [11, "context", " context"],
  ]);
});

test("patchset parser ignores ordinary patches", () => {
  assert.deepEqual(parsePatchSetSections(`@@ -1 +1 @@
-old
+new`), []);
});
