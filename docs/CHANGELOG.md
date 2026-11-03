# Changelog

## 0.1.0 — 2026-11-03

- Initial MCP server: Next.js 16 + mcp-handler 2.3 (MCP SDK v2), stateless Streamable HTTP at `/api/mcp`.
- `x-api-key` guard (constant-time; 401 before MCP), fail-closed startup guardrails
  (tenant/env, Vercel env + branch, Moodle host allow-list).
- Tenant `gla` with staging/production overlays.
- Moodle connector (core read functions only), fixture connector for local dev/tests.
- Tools: `list_courses`, `get_dimensions`, `get_access_summary`, `get_course_access`, `get_dealer_access`.
- Docs: architecture, metrics (definitions `2026-11-mvp1`), deployment, Moodle setup, Claude connector, tenant onboarding, ADRs, roadmap.
- CI: typecheck, lint, format, tests, build.
