# CLAUDE.md

Persistent context for Claude Code in this repo. **Read `docs/ARCHITECTURE.md`,
`docs/METRICS.md` and `docs/DECISIONS.md` before changing code.**

## Rules

1. **Read-only.** No tool may write to any connected system. New Moodle functions added to
   the service must be `type: read`. Every tool uses `READ_ONLY_ANNOTATIONS`.
2. **No secrets in code, tests, docs, logs or tool output.** Env var _names_ only. Never log
   request headers, Moodle response bodies or personal data; the logger redacts known
   sensitive field names but do not rely on it.
3. **Layering.** `tools/` → `domain/` → `ports/` ← `connectors/`. Tools never import
   connectors; domain code never imports Moodle types. Client-specific values live only in
   `src/tenants/<id>/`.
4. **Deterministic metrics.** Every number is computed server-side by pure functions in
   `src/domain/`. Changing a metric's meaning = update `docs/METRICS.md` and bump
   `DEFINITIONS_VERSION` in `src/domain/envelope.ts`.
5. **Fail closed.** Config problems stop the server (500); missing/wrong `x-api-key` → 401
   before the MCP handler runs.
6. **Verify.** Run `npm run check` (typecheck + lint + tests) and `npm run build` before
   committing. Do not weaken lint/TS config to pass — fix the code.
7. **Docs travel with code.** Update `docs/` (and `docs/CHANGELOG.md`) in the same change
   when behaviour, metrics, config, env vars or deployment change.

## Commands

`npm run dev` · `npm run check` · `npm run build` · `npm run format`

## Branches

`feature/*` → PR into `release` (deploys staging) → PR `release` → `main` (deploys prod).
Only `main` and `release` deploy on Vercel (`vercel.json`).
