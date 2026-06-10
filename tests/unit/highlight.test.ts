import assert from "node:assert/strict";
import test from "node:test";

import { highlightedHtml } from "../../web/src/lib/highlight.js";

test("syntax highlighting preserves diff markers outside code tokens", () => {
  assert.match(highlightedHtml("+from __future__ import annotations", "python"), /^\+<span class="hljs-keyword">from<\/span>/);
  assert.match(highlightedHtml(" def epilogue_source_digest(source: str) -> str:", "python"), /^ <span class="hljs-keyword">def<\/span>/);
});
