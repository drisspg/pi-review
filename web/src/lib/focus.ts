import type { FocusArea } from "../types";

function focusAreaPath(path: string): string {
  return path.trim().replace(/^[-*]\s+/, "").trim();
}

function nearbyMarkdown(text: string, index: number): string {
  const nextItem = text.slice(index + 1).search(/\n\s*(?:[-*]|\d+[.)])\s+[`*_]*[\w./@+-][^\n]*:\d+/);
  const end = nextItem === -1 ? text.length : index + 1 + nextItem;
  return text.slice(index, end).trim();
}

export function parseFocusAreas(text: string): FocusArea[] {
  const location = /^\s*(?:(?:[-*]|\d+[.)])\s+)?[`*_]*([\w./@+-][\w./@+ -]*?\.[\w+-]+):(\d+)(?:-(\d+))?(?:\s*[—-]\s*([^\n]+))?/gm;
  const areas: FocusArea[] = [];
  for (const match of text.matchAll(location)) {
    const path = focusAreaPath(match[1]);
    const startLine = Number.parseInt(match[2], 10);
    const endLine = Number.parseInt(match[3] ?? match[2], 10);
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) continue;
    areas.push({ id: `${path}:${startLine}-${endLine}:${areas.length}`, path, startLine: Math.min(startLine, endLine), endLine: Math.max(startLine, endLine), title: (match[4] ?? "Focus area").trim().replace(/[`*_]+$/g, "").trim(), body: nearbyMarkdown(text, match.index ?? 0) });
  }
  return areas;
}
