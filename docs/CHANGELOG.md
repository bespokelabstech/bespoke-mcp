# Changelog

## 0.1.1 — 2026-11-03

First staging run fixes:

- Moodle errors now name the web-service function and Moodle `errorcode` (never Moodle's free-text message).
- Course, category, user and profile strings are HTML-entity decoded and trimmed (`&amp;` → `&`).
- `list_courses`: categories the service account cannot see return a warning ("do not guess");
  `completion_tracked` is `null` (unknown) when Moodle does not disclose it.
- Server instructions tell Claude never to fill in values the server did not return.
- Moodle setup: add `moodle/category:viewhiddencategories`; document which "missing capabilities" to leave ungranted.

## 0.1.0 — 2026-11-03

- Initial MCP server: Next.js 16 + mcp-handler 2.3 (MCP SDK v2), stateless Streamable HTTP at `/api/mcp`.
- `x-api-key` guard (constant-time; 401 before MCP), fail-closed startup guardrails
  (tenant/env, Vercel env + branch, Moodle host allow-list).
- Tenant `gla` with staging/production overlays.
- Moodle connector (core read functions only), fixture connector for local dev/tests.
- Tools: `list_courses`, `get_dimensions`, `get_access_summary`, `get_course_access`, `get_dealer_access`.
- Docs: architecture, metrics (definitions `2026-11-mvp1`), deployment, Moodle setup, Claude connector, tenant onboarding, ADRs, roadmap.
- CI: typecheck, lint, format, tests, build.
