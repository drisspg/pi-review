import { parseReviewVisual } from "../../../src/review-visual";

export function ReviewVisual({ code }: { code: string }) {
  const paths = parseReviewVisual(code);
  if (paths == null) return <pre className="review-visual-source"><code>{code}</code></pre>;
  return <figure className="review-visual" aria-label="Path comparison">
    {paths.map(({ label, steps }, index) => <div className="review-visual-path" key={index}>
      <strong>{label}</strong>
      <ol role="list" aria-label={label}>
        {steps.map((step, stepIndex) => <li key={stepIndex}>{step}</li>)}
      </ol>
    </div>)}
  </figure>;
}
