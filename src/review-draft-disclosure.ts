/**
 * Disclosure line for model-drafted review comments. It labels AI involvement (instead of a
 * quote block) while making the reviewer's sign-off explicit; the reviewer directs and approves
 * every draft, so the body below it is plain text in the reviewer's voice.
 */
export const AI_DRAFT_HEADER = "_AI-drafted; I've reviewed and agree._";

/** Earlier disclosure header, stripped so re-formatting old drafts does not stack labels. */
const LEGACY_AI_DRAFT_HEADER = "#### AI-assisted";

export function hasAiDraftDisclosure(body: string): boolean {
  const firstLine = body.trimStart().split("\n", 1)[0].trimEnd();
  if (firstLine === AI_DRAFT_HEADER || firstLine === LEGACY_AI_DRAFT_HEADER) return true;
  const label = firstLine.replace(/^>?\s*\**/, "").split(":", 1)[0];
  return firstLine.includes(":") && /^(?:non-blocking follow-up — )?AI[- ](?:assisted|generated) (?:(?:review|implementation|cleanup|naming) )?(?:draft|note|suggestion|review|nit|investigation)$/i.test(label);
}

/**
 * Normalize a model-drafted body to the header convention: unwrap a whole-body quote block,
 * drop "AI-assisted …:" lead-ins, and put the header on its own line. Idempotent.
 */
export function formatAiDraftBody(body: string): string {
  let text = body.trim();
  for (const header of [AI_DRAFT_HEADER, LEGACY_AI_DRAFT_HEADER]) {
    if (text.startsWith(header)) text = text.slice(header.length).trim();
  }
  const lines = text.split("\n");
  if (lines.filter((line) => line.trim().length > 0).every((line) => line.trimStart().startsWith(">"))) {
    text = lines.map((line) => line.replace(/^\s*> ?/, "")).join("\n").trim();
  }
  text = text.replace(/^\**AI[- ]assisted[^:\n]{0,40}:\**\s*/i, "").trim();
  return `${AI_DRAFT_HEADER}\n\n${text}`;
}

/** Shared wording so every Pi surface describes the comment format the same way. */
export const AI_DRAFT_FORMAT_GUIDELINE = `Pi Review adds the "${AI_DRAFT_HEADER}" disclosure line to every draft automatically. Write the body as plain text in the reviewer's voice (the reviewer directs these comments): no quote blocks, no ">" prefixes, and no "AI-assisted suggestion:" lead-ins.`;
