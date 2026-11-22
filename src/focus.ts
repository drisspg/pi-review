export type FocusArea = { id: string; path: string; startLine: number; endLine: number; title: string; body: string };

/** Mask fenced examples without moving offsets used to slice the original Markdown. */
function maskFencedCode(text: string): string {
  let fence = "";
  return text.split("\n").map(line => {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker?.[1].startsWith(fence) && !marker[2].trim()) fence = "";
    } else if (marker) {
      fence = marker[1];
    } else {
      return line;
    }
    return "~".repeat(line.length);
  }).join("\n");
}

const evidenceHeading = /^[ \t]*### Evidence[ \t]*\r?$/m;

export function splitFocusEvidence(body: string): { explanation: string; evidence: string } {
  const heading = evidenceHeading.exec(maskFencedCode(body));
  return heading ? { explanation: body.slice(0, heading.index).trim(), evidence: body.slice(heading.index + heading[0].length).trim() } : { explanation: body.trim(), evidence: "" };
}

/** Extract only the published section. Repeated real headings are ambiguous. */
export function publishedFocusSection(answer: string): string | undefined {
  const matches = [...maskFencedCode(answer).matchAll(/^## Focus areas[ \t]*\r?$/gm)];
  return matches.length === 1 ? answer.slice(matches[0].index! + matches[0][0].length).trim() : undefined;
}

function focusAreaPath(path: string): string {
  return path.trim().replace(/^[-*]\s+/, "").trim();
}

function focusAreaTitle(match: RegExpMatchArray): string {
  const title = (match.groups?.title ?? "Focus area").trim();
  const wrapper = match.groups?.wrapper;
  return wrapper && !match.groups?.closedPath && title.endsWith(wrapper) ? title.slice(0, -wrapper.length).trimEnd() : title;
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

export function parseFocusAreas(text: string, format: "saved" | "verified" = "saved"): FocusArea[] {
  const location = /^[ \t]*(?:(?<heading>###)[ \t]+|(?:[-*]|\d+[.)])[ \t]+)?(?<wrapper>[`*_]+)?(?<path>[\w./@+-][\w./@+ -]*?):(?<start>\d+)(?:-(?<end>\d+))?(?<closedPath>\k<wrapper>)?(?:[ \t]*[—-][ \t]*(?<title>[^\n]+))?/gm;
  const markdown = maskFencedCode(text);
  const locations = [...text.matchAll(location)].map((match, ordinal) => ({ match, ordinal }));
  const outsideFences = locations.filter(({ match }) => markdown[match.index] !== "~");
  const headings = outsideFences.filter(({ match }) => match.groups?.heading);
  // Current findings are headings; ordinary citations in Evidence are just Markdown.
  // Legacy ids include the original ordinal, even when a fenced citation is hidden.
  const matches = format === "verified" || headings.length ? headings : outsideFences;
  const areas: FocusArea[] = [];
  for (const [index, { match, ordinal }] of matches.entries()) {
    const { path: rawPath, start, end, wrapper, closedPath, title } = match.groups!;
    // An unpaired leading underscore belongs to the filename, not emphasis.
    const path = focusAreaPath(wrapper?.startsWith("_") && !closedPath && !title?.trimEnd().endsWith(wrapper) ? wrapper + rawPath : rawPath);
    const startLine = Number(start);
    const endLine = Number(end ?? start);
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) continue;
    areas.push({ id: `${path}:${startLine}-${endLine}:${headings.length ? index : ordinal}`, path, startLine: Math.min(startLine, endLine), endLine: Math.max(startLine, endLine), title: focusAreaTitle(match), body: focusAreaBody(text, match, matches[index + 1]?.match) });
  }
  return areas;
}

/** A specific missing check, not a successful clean scan. */
export function focusReviewIsInconclusive(text: string): boolean {
  return /^Investigation inconclusive: \S[^\n]*$/i.test(text.trim());
}

/** Accept an explicit empty conclusion after scan notes, but never hide parsed findings. */
export function focusReviewHasNoFindings(text: string): boolean {
  return /\bNo focus areas found\.\s*$/i.test(text) && parseFocusAreas(text).length === 0;
}
