/** The PR overview is one self-contained show-me HTML page, rendered in a sandboxed frame. */

/** Pages larger than this are not a glanceable overview and are refused. */
export const OVERVIEW_HTML_MAX_CHARS = 400_000;

const documentPattern = /<!doctype html[\s\S]*<\/html\s*>/i;

/** The HTML document in a model answer (bare or fenced), or null when there is none. */
export function extractOverviewHtml(answer: string): string | null {
  const html = documentPattern.exec(answer)?.[0];
  return html != null && html.length <= OVERVIEW_HTML_MAX_CHARS ? html : null;
}

/** Saved overviews written before the HTML contract are markdown sections. */
export function isOverviewHtml(answer: string): boolean {
  return /^\s*<!doctype html/i.test(answer);
}
