/**
 * The PR overview is a model-written show-me page, so it only ever runs in a sandboxed frame
 * (opaque origin) with a CSP that blocks every network request. A bridge script themes it like
 * the app and turns file:line chips and the walkthrough's `j` key into messages to the app.
 */

export const overviewMessages = { ref: "pi-review-ref", key: "pi-review-key", theme: "pi-review-theme" } as const;

export type OverviewTheme = "light" | "dark";

// Ahead of any page content, so it governs everything the page loads.
const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">`;

function bridge(theme: OverviewTheme): string {
  const m = JSON.stringify(overviewMessages);
  return `<script>(function(){var m=${m};var d=document.documentElement;d.dataset.theme=${JSON.stringify(theme)};`
    + `addEventListener("message",function(e){if(e.source===parent&&e.data&&e.data.type===m.theme)d.dataset.theme=e.data.theme});`
    + `addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("[data-ref]");if(!a)return;e.preventDefault();parent.postMessage({type:m.ref,ref:a.getAttribute("data-ref")},"*")});`
    + `addEventListener("keydown",function(e){if(e.key==="j"&&!e.defaultPrevented&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&!(e.target.closest&&e.target.closest("input,textarea,select,[contenteditable]")))parent.postMessage({type:m.key,key:"j"},"*")});})();</script>`;
}

/** The frame's srcdoc: the page with the CSP and bridge first in its head. */
export function overviewFrameDocument(html: string, theme: OverviewTheme): string {
  const preamble = csp + bridge(theme);
  // Only a head before the body counts, and `<head` must not match `<header`; a page without
  // one gets a head before its body.
  const body = html.search(/<body[\s>]/i);
  const head = /<head(?:\s[^>]*)?>/i.exec(body < 0 ? html : html.slice(0, body));
  if (head) return html.slice(0, head.index + head[0].length) + preamble + html.slice(head.index + head[0].length);
  const root = /<html(?:\s[^>]*)?>/i.exec(html);
  const at = root ? root.index + root[0].length : (/<!doctype html[^>]*>/i.exec(html)?.[0].length ?? 0);
  return html.slice(0, at) + `<head>${preamble}</head>` + html.slice(at);
}

/**
 * A page for a new tab. A blob URL takes the app's origin, so the tab holds no page script
 * itself: it only frames the page with the same sandbox as the review pane.
 */
export function overviewTabDocument(html: string, theme: OverviewTheme): string {
  const srcdoc = overviewFrameDocument(html, theme).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<!doctype html><html><head><meta charset="utf-8"><title>PR overview</title><style>html,body{margin:0;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe sandbox="allow-scripts" srcdoc="${srcdoc}"></iframe></body></html>`;
}

/** `path:line` or `path:start-end` from a chip's data-ref. */
export function parseOverviewRef(ref: unknown): { path: string; line: number } | null {
  const match = typeof ref === "string" ? /^(.+?):(\d+)(?:-\d+)?$/.exec(ref) : null;
  return match ? { path: match[1], line: Number.parseInt(match[2], 10) } : null;
}
