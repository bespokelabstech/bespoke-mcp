# Changelog

## 0.3.1 — 2026-11-05

- `list_people` `sort: "enrolment_order"` + `cursor`: browse very large courses page by page
  (reads only the pages needed); the whole-course mode now suggests it when a course is too
  large instead of timing out (the largest staging course took 49 s of the 50 s budget).
- `population.dealer_duplicate_accounts_merged` explains accounts vs people differences.
- Placeholder values typed instead of a Conso ID (`n/a`, `none`, …) are treated as empty.

## 0.3.0 — 2026-11-04

After the first live checks on staging (definitions `2026-11-mvp3`):

- **Answers in parts, mid-course:** enrolment-level questions page through each course, so
  the largest course (≈6.4K enrolments, 47 s alone) no longer sinks an all-courses question.
- **`started` / `completion` for any scope size:** always computed in batches of people
  (one call when small, parts when large), resumed by last processed person.
- Compact cursor (positional arrays) with an early size check; region look-alike notes carried
  across parts; grade report fetched once per course per part; enrolment pages cached once.
- `avg_score` with `started`/`completion` in the same query is skipped with a reason.
- A timeout while reading a Moodle response is reported as a timeout (was "unreadable
  response"), and a part that runs out of time returns what it finished plus the cursor.
- Dummy rule: one digit repeated at any length (`0`, `000`, `00000`) — was 12 digits only.
- `skipped_signals` field when a requested signal cannot be computed.
- Enrolment unit now counts account × course as Moodle records it (duplicate accounts merge
  only in the people unit), so parts are exactly additive.

## 0.2.0 — 2026-11-04

Redesign after the staging investigation (definitions `2026-11-mvp2`, see METRICS):

- **Tools:** `describe_capabilities`, `list_courses`, `list_dimension_values`, `query_metrics`,
  `list_people`, `get_person` replace the 0.1 tools.
- **Signals:** `started` (default), `completion`, `site_last_access`, `web_course_access`
  (labelled web-only — the app does not update it), `avg_score` (grade report, detected).
- **Population:** dealer / legacy / excluded statuses with reasons; Conso ID normalisation
  (11→12 digits) and one count per Conso ID; dummy patterns and staff Dealer Level.
- **Speed:** enrolments pulled without custom fields; profiles once per account, batched;
  concurrency 2; 5-minute in-memory cache.
- **Answers in parts** for enrolment-level queries via a signed, stateless cursor.
- Region/branch values verbatim with "separate values" notes for look-alikes.
- Category filter works for categories hidden from the service account.
- Moodle's reason for course-access failures is shown with a hint.
- Every result carries `diagnostics` (`ms`, `lms_calls`).
- Moodle setup: grade report (optional), service-account prerequisites (required profile
  fields, site policy acceptance).

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
