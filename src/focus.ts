export type FocusArea = { id: string; path: string; startLine: number; endLine: number; title: string; body: string };

function focusAreaPath(path: string): string {
  return path.trim().replace(/^[-*]\s+/, "").trim();
}

function focusAreaTitle(match: RegExpMatchArray): string {
  return (match[4] ?? "Focus area").trim().replace(/[`*_]+$/g, "").trim();
}

function focusAreaBody(text: string, match: RegExpMatchArray, nextMatch: RegExpMatchArray | undefined): string {
  const start = (match.index ?? 0) + match[0].length;
  const lines = text.slice(start, nextMatch?.index ?? text.length).trim().split("\n");
  if (nextMatch != null) {
    const trailingTitle = lines.at(-1)?.trim().replace(/^(?:[-*]|\d+[.)])\s+/, "").replace(/[`*_]+/g, "").trim();
    if (trailingTitle === focusAreaTitle(nextMatch)) lines.pop();
  }
  return lines.join("\n").trim();
}

export function parseFocusAreas(text: string): FocusArea[] {
  const location = /^\s*(?:(?:[-*]|\d+[.)])\s+)?[`*_]*([\w./@+-][\w./@+ -]*?):(\d+)(?:-(\d+))?(?:\s*[—-]\s*([^\n]+))?/gm;
  const matches = [...text.matchAll(location)];
  const areas: FocusArea[] = [];
  for (const [index, match] of matches.entries()) {
    const path = focusAreaPath(match[1]);
    const startLine = Number.parseInt(match[2], 10);
    const endLine = Number.parseInt(match[3] ?? match[2], 10);
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) continue;
    areas.push({ id: `${path}:${startLine}-${endLine}:${areas.length}`, path, startLine: Math.min(startLine, endLine), endLine: Math.max(startLine, endLine), title: focusAreaTitle(match), body: focusAreaBody(text, match, matches[index + 1]) });
  }
  return areas;
}

/** Accept an explicit empty conclusion after scan notes, but never hide parsed findings. */
export function focusReviewHasNoFindings(text: string): boolean {
  return /\bNo focus areas found\.\s*$/i.test(text) && parseFocusAreas(text).length === 0;
}
