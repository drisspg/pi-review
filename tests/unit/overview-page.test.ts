import assert from "node:assert/strict";
import test from "node:test";

import { extractOverviewHtml, OVERVIEW_HTML_MAX_CHARS } from "../../src/overview-html.js";
import { overviewFrameDocument, overviewTabDocument, parseOverviewRef } from "../../web/src/lib/overview-page.js";

const page = "<!doctype html>\n<html lang=\"en\"><head><title>t</title></head><body><header>x</header></body></html>";

test("an overview answer yields exactly one complete, bounded page", () => {
  assert.equal(extractOverviewHtml("Here you go:\n```html\n" + page + "\n```"), page);
  assert.equal(extractOverviewHtml(page.replace("</html>", "")), null, "a truncated page is refused");
  assert.equal(extractOverviewHtml(page.replace("<body>", "<body>" + "x".repeat(OVERVIEW_HTML_MAX_CHARS))), null, "an oversized page is refused");
});

test("the frame document puts the CSP and bridge first in the head, never in a <header>", () => {
  const framed = overviewFrameDocument(page, "dark");
  assert.ok(framed.startsWith("<!doctype html>"), "standards mode is kept");
  const head = framed.indexOf("<head>");
  assert.ok(framed.indexOf("Content-Security-Policy") > head && framed.indexOf("Content-Security-Policy") < framed.indexOf("<title>"));
  assert.match(framed, /default-src 'none'/);
  assert.match(framed, /dataset\.theme="dark"/);
  assert.equal(framed.indexOf("<header>"), framed.indexOf("<header>x"), "the header is untouched");
  const headless = overviewFrameDocument("<!doctype html><html><body>hi</body></html>", "light");
  assert.match(headless, /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"[\s\S]*<\/head><body>hi/);
});

test("the new-tab document only frames the page in the same sandbox", () => {
  const tab = overviewTabDocument('<!doctype html><html><head></head><body><script>fetch("/api")</script><a title="a&b">x</a></body></html>', "dark");
  assert.match(tab, /<iframe sandbox="allow-scripts" srcdoc="/);
  const outside = tab.replace(/srcdoc="[^"]*"/, "");
  assert.doesNotMatch(outside, /<script/i, "no page script runs at the app's origin");
  assert.match(tab, /title=&quot;a&amp;b&quot;/, "the page survives attribute escaping");
});

test("file chips parse to a path and the first line", () => {
  assert.deepEqual(parseOverviewRef("quack/copy_utils.py:481-492"), { path: "quack/copy_utils.py", line: 481 });
  assert.equal(parseOverviewRef("no line"), null);
  assert.equal(parseOverviewRef(42), null);
});
