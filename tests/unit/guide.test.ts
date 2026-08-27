import assert from "node:assert/strict";
import test from "node:test";

import { parseGuideDocument } from "../../web/src/lib/guide.js";

test("guide parser groups ordered code stops into conceptual chapters", () => {
  const guide = parseGuideDocument(`## Review guide
## Change flow
\`\`\`text
public_api
  shared_kernel
\`\`\`
### 1. Core recurrence
Understand the shared recurrence before its callers.
- src/kernel.py:10-20 — Scan loop
  Follow the state update through one token.
- src/kernel.py:30-34 — Final state
  See how state is returned.
### 2. Integration
Then follow the public wrapper.
- src/api.py:7 — Public launcher
  Connect user inputs to the shared kernel.`);

  assert.equal(guide.flow, "\`\`\`text\npublic_api\n  shared_kernel\n\`\`\`");
  assert.deepEqual(guide.chapters.map((chapter) => ({ title: chapter.title, body: chapter.body, steps: chapter.steps.map((step) => ({ title: step.title, path: step.path, body: step.body })) })), [
    {
      title: "Core recurrence",
      body: "Understand the shared recurrence before its callers.",
      steps: [
        { title: "Scan loop", path: "src/kernel.py", body: "Follow the state update through one token." },
        { title: "Final state", path: "src/kernel.py", body: "See how state is returned." },
      ],
    },
    {
      title: "Integration",
      body: "Then follow the public wrapper.",
      steps: [{ title: "Public launcher", path: "src/api.py", body: "Connect user inputs to the shared kernel." }],
    },
  ]);
});