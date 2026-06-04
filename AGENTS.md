# Pi Review Agent Guidance

## Backend-first feature workflow

When implementing or prototyping a new Pi Review feature, prove the behavior through the backend contract before relying on the frontend.

- Put durable feature behavior in an injectable `src/*-api.ts` module with focused unit tests.
- Keep `src/server.ts` as dependency wiring and lifecycle only; route dispatch belongs in `src/server-router.ts` or a feature API module.
- Add or extend typed backend contracts before wiring UI text/protocols into React. Use `/api/pi/prompt` modes for durable agent prompts instead of constructing long prompts in the frontend.
- For “test this PR” or “have an agent try this out” flows, use the `test-pr` prompt contract via `/api/pi/prompt` with `{ mode: "test-pr", prKey, testIntent, files?, gpuRequired? }`.
- Validate backend behavior from the CLI first: targeted unit tests, direct module calls, local HTTP requests, or command-line repros against the checked-out PR/worktree.
- Only move to frontend/browser checks after the backend behavior is proven, or when the change is specifically UI wiring/interaction.

## Validation expectations

- Run the most relevant targeted unit tests for the changed backend contract.
- Run `npm run typecheck` and `npm run build` before handoff.
- Run `npm run test:e2e` or targeted Playwright tests when frontend/server wiring changes materially.
- Treat the two fixture-drift e2e failures documented in `.agents/skills/pi-review-ux/SKILL.md` as known only after confirming they match the documented failures.

## Performance expectations

Backend contract endpoints should stay cheap enough for iterative agent prototyping. If a new route adds filesystem, GitHub, Pi/LLM, GPU, or subprocess work, keep the expensive part explicit in the contract and test the pure transformation/validation layer separately.
