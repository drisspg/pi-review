export type ReviewVisualLane = { label: string; steps: string[] };
export type ReviewVisual = [ReviewVisualLane, ReviewVisualLane];

export const reviewVisualInstructions = `Use the show-me skill when available: pick the smallest picture that answers the reader's question and put it beside the sentence it explains, before any Evidence appendix. Don't start by choosing a template. For a boundary, draw the actual span and mark the first invalid position; for a partition, show how the work divides; for arithmetic, show a worked calculation. A short fenced text sketch or diff is enough. For relationships that are clearer as a graph, use fenced schematic JSON: {"nodes":[{"id":"a","label":"…"},{"id":"b","label":"…"}],"edges":[{"from":"a","to":"b","label":"…"}]}. If two paths really are the clearest comparison, a fenced review-visual block takes two lines of 'Label: step → step' (2–4 steps each). Don't default to Before/After cards or repeat your prose in boxes. Use only values supported by the evidence; label predictions as predictions.`;

/** Two labeled paths. Keeping this plain text also makes copied reviews readable outside the UI. */
export function parseReviewVisual(code: string): ReviewVisual | null {
  const lines = code.trim().split(/\r?\n/);
  if (lines.length !== 2) return null;
  const lanes = lines.map(line => {
    const colon = line.indexOf(":");
    if (colon < 1) return null;
    const label = line.slice(0, colon).trim();
    const steps = line.slice(colon + 1).split("→").map(step => step.trim());
    if (!label || steps.length < 2 || steps.length > 4 || steps.some(step => !step)) return null;
    return { label, steps };
  });
  const [left, right] = lanes;
  return left && right ? [left, right] : null;
}
