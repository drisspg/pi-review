import { parseFocusAreas } from "./focus";
import type { FocusArea } from "../types";

export type GuideChapter = { id: string; title: string; body: string; steps: FocusArea[] };
export type GuideDocument = { flow: string; chapters: GuideChapter[] };

function chapterTitle(rawTitle: string): string {
  return rawTitle.replace(/^\d+[.)]\s*/, "").trim();
}

/** Parse a guided-review response into its change flow and ordered code stops. */
export function parseGuideDocument(text: string): GuideDocument {
  const heading = /^###\s+(.+)$/gm;
  const matches = [...text.matchAll(heading)];
  const flowHeading = /^##\s+Change flow\s*$/m.exec(text);
  const flowStart = flowHeading == null ? -1 : (flowHeading.index ?? 0) + flowHeading[0].length;
  const flow = flowStart === -1 ? "" : text.slice(flowStart, matches[0]?.index ?? text.length).trim();
  const chapters = matches.flatMap((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const section = text.slice(start, matches[index + 1]?.index ?? text.length).trim();
    const steps = parseFocusAreas(section);
    if (steps.length === 0) return [];
    const firstLocation = section.search(/^\s*(?:(?:[-*]|\d+[.)])\s+)?[`*_]*[\w./@+-][\w./@+ -]*?\.[\w+-]+:\d+/m);
    return [{
      id: `guide-chapter-${index}`,
      title: chapterTitle(match[1]),
      body: (firstLocation === -1 ? section : section.slice(0, firstLocation)).trim(),
      steps: steps.map((step, stepIndex) => ({ ...step, id: `guide-chapter-${index}-step-${stepIndex}` })),
    }];
  });
  return { flow, chapters };
}
