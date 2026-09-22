# AI quality skills

## Installation record — 2026-09-22

Added at the user's request for testing, accessibility, responsive design, and
security. These are personal Codex skills installed in `~/.agents/skills`, shared
by the frontend and backend repositories. They are development guidance, not app
dependencies, CI jobs, or proof that the application passed an audit.

The installation used Codex's skill-installer helper with pinned Git revisions.
No application code or test dependencies changed during this setup. These skills
were added after initial development; do not attribute earlier work to them.

## Selected skills

| Area | Skill and source | Intended use in this project |
| --- | --- | --- |
| Unit/API testing | [javascript-testing-patterns](https://skills.sh/wshobson/agents/javascript-testing-patterns) — wshobson/agents | Deterministic fixtures, boundary cases, failures, API/database assertions. |
| Browser testing | [e2e-testing-patterns](https://skills.sh/wshobson/agents/e2e-testing-patterns) — wshobson/agents | Playwright user journeys, reliable locators/waits, regression tests. |
| Accessibility/UI | [web-design-guidelines](https://skills.sh/vercel-labs/agent-skills/web-design-guidelines) — Vercel | Labels, keyboard/focus behavior, forms, semantics, visual usability. |
| Responsive design | [responsive-design](https://skills.sh/wshobson/agents/responsive-design) — wshobson/agents | Mobile-first layouts, fluid sizing, navigation, tables and overflow. |
| Security | [security-best-practices](https://skills.sh/openai/skills/security-best-practices) — OpenAI | Framework-specific React and Express security review and secure coding. |

Selection checks included reading each SKILL.md, checking its source repository,
and checking adoption on skills.sh. Approximate install counts at selection:
19K JavaScript testing, 22.9K E2E testing, 655K web guidelines, 19.1K responsive
design, and 9K security. Repository stars: wshobson/agents 39.9K,
vercel-labs/agent-skills 31.4K, openai/skills 27.5K. Popularity is a selection
signal, not a guarantee of correctness or security. The wshobson skills are
community-maintained; the other two come from their vendors.

## Reproduce the pinned installation

Requires Python 3 and Codex's bundled skill-installer. Run locally, not in the
application container. Existing skill directories are not overwritten.

```sh
ACME_SKILL_INSTALLER="${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-installer/scripts/install-skill-from-github.py"

python3 "$ACME_SKILL_INSTALLER" --repo wshobson/agents \
  --ref 4236bb91f8395b0435f1d8b8baf9e8e4c69a8620 \
  --path plugins/javascript-typescript/skills/javascript-testing-patterns \
         plugins/developer-essentials/skills/e2e-testing-patterns \
         plugins/ui-design/skills/responsive-design \
  --dest "$HOME/.agents/skills"

python3 "$ACME_SKILL_INSTALLER" --repo vercel-labs/agent-skills \
  --ref 063bee94c3f4df8453406c830b0a7df0f2860278 \
  --path skills/web-design-guidelines --dest "$HOME/.agents/skills"

python3 "$ACME_SKILL_INSTALLER" --repo openai/skills \
  --ref 49f948faa9258a0c61caceaf225e179651397431 \
  --path skills/.curated/security-best-practices --dest "$HOME/.agents/skills"
```

The Vercel skill fetches current upstream guidelines during each review, so its
review rules can change even though the skill itself is pinned. Record the
guideline retrieval date in future audit reports.

## Applying these skills here

- Preserve the existing backend `node:test`/`tsx`/Supertest and frontend
  TypeScript Playwright setup. Generic Jest, Vitest, or Cypress examples do not
  justify migrating this assessment's test stack.
- Use isolated test databases and synthetic employee data. Never run cleanup
  examples against the real employee database. Keep fixtures and rates
  deterministic; distinguish mocked browser tests from live end-to-end coverage.
- Prefer accessible role/label locators. Use test IDs only when needed. Include
  keyboard navigation, visible focus, dialog focus handling, form errors and
  contrast in accessibility reviews; automated checks alone are insufficient.
- Check narrow phones, tablets and desktop widths, zoom, long names/emails,
  employee-count ratios and tables. Keep horizontal scrolling inside the table,
  not the whole page. Preserve the current visual design.
- Review both React and Express: server-side permissions, sessions, invitations,
  actor attribution, sensitive salary access, validation, uploads, injection,
  XSS and CSRF. Use synthetic/local data and do not expose credentials.
- Keep findings and proposed fixes separate. A review request does not authorize
  deploying changes or rewriting authentication. Report known test failures
  explicitly instead of hiding them with skips or weakened assertions.

Example future requests:

- `Use $javascript-testing-patterns and $e2e-testing-patterns to assess test gaps; keep the existing runners.`
- `Use $web-design-guidelines to review the dashboard and forms for accessibility; report findings first.`
- `Use $responsive-design to check the employee page at 320, 390, 768 and 1440 pixels; report overflow issues.`
- `Use $security-best-practices to review authentication, permissions, imports and salary changes; report findings without changing code.`

For each actual use, record the date, prompt, skill(s), scope, findings, decisions,
verification commands/results, and related commit. Do not describe this
installation record as an already-completed audit.

See [official skill documentation](https://learn.chatgpt.com/docs/build-skills)
for discovery and invocation. Installed skills should be available on the next
turn; if they do not appear, restart Codex.
