export type ReviewVisualLane = { label: string; steps: string[] };
export type ReviewVisual = [ReviewVisualLane, ReviewVisualLane];

export const reviewVisualInstructions = "Finish with one top-level fenced review-visual block (before Evidence, if present). Put exactly two lines of plain text inside, each in the form 'Label: first step → next step → outcome'. Use 2–4 short steps per lane and concrete labels without colons. Show the same supported input on both sides when comparing behaviors. Use before/after, expected/actual, or two cooperating roles; never invent a difference, measurement, or result. Label predictions as such in the prose. Use the actual Unicode arrow →, not a Markdown table or an image link.";

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
