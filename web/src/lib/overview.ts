export type OverviewSections = {
  tldr: string;
  schematic: string;
  changeMap: string;
  notes: string;
};

const SECTION_HEADERS: Array<{ key: keyof OverviewSections; pattern: RegExp }> = [
  { key: "tldr", pattern: /^##\s*tl;?dr\b/i },
  { key: "schematic", pattern: /^##\s*schematic\b/i },
  { key: "changeMap", pattern: /^##\s*change map\b/i },
  { key: "notes", pattern: /^##\s*reviewer notes\b/i },
];

/** Split a structured overview answer into UI panels; null means legacy free-form markdown. */
export function parseOverviewSections(text: string): OverviewSections | null {
  const collected: Partial<Record<keyof OverviewSections, string[]>> = {};
  const preamble: string[] = [];
  let current: keyof OverviewSections | null = null;
  let sawSection = false;
  for (const line of text.split("\n")) {
    const header = SECTION_HEADERS.find(({ pattern }) => pattern.test(line.trim()));
    if (header != null) {
      current = header.key;
      sawSection = true;
      collected[current] ??= [];
      continue;
    }
    if (/^##\s/.test(line.trim())) {
      current = null;
      continue;
    }
    if (current != null) collected[current]?.push(line);
    else if (!sawSection) preamble.push(line);
  }
  if (collected.tldr == null || collected.schematic == null) return null;
  const intro = preamble.join("\n").trim();
  const tldr = (collected.tldr ?? []).join("\n").trim();
  return {
    tldr: intro.length > 0 ? `${intro}\n\n${tldr}`.trim() : tldr,
    schematic: (collected.schematic ?? []).join("\n").trim(),
    changeMap: (collected.changeMap ?? []).join("\n").trim(),
    notes: (collected.notes ?? []).join("\n").trim(),
  };
}
