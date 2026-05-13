---
name: pi-review-ux
description: Use when changing, testing, or reviewing the Pi Review web UI/UX. Covers running the local app, using agent-browser for exploratory browser checks, and validating with the project test suite.
---

# Pi Review UX

Use this skill for Pi Review web UI changes, exploratory UX checks, accessibility tree inspection, screenshots, and browser-driven bug reproduction.

## Browser automation

Use the installed `agent-browser` CLI for browser work. The source-managed global skill is:

`~/.agents/skills/agent-browser/SKILL.md`

Before invoking `agent-browser`, load the installed version's workflow content:

```bash
agent-browser skills get core
```

Use `agent-browser skills get core --full` when you need the full command reference. Prefer the CLI's current skill content over memorized commands because it matches the installed `agent-browser` version.

## Local app workflow

Run the app from the repo root:

```bash
npm run dev
```

The web app is served by Vite and the API server runs alongside it. Use browser automation against the Vite URL printed by the command, normally `http://127.0.0.1:5173`.

## Validation

For behavior changes, run the most targeted command first when possible, then the full validation before handoff:

```bash
npm run typecheck
npm run build
npm run test:e2e
```

The full project validation is:

```bash
npm run validate
```

## UX review checklist

- Drive the changed flow in the browser instead of only reading code.
- Capture a screenshot or accessibility-tree snapshot for visual or interaction issues.
- Check keyboard/focus behavior for modals, menus, comment threads, and the Pi side panel.
- Verify loading, empty, error, and success states when the change touches data fetching or Pi responses.
- Keep fixes in source files under `src/` and `web/src/`; generated `dist-*` files are build artifacts unless the release flow explicitly requires them.
