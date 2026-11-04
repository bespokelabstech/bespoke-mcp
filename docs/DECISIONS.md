# Decision log

## ADR-001 — Standalone service, Moodle REST core functions only (2026-11)

**Decision.** The MCP server is an independent Next.js app on Vercel that reads Moodle only
through core REST web-service functions with a restricted token. No Moodle plugin, no Go
backend dependency for the MVP.

**Why.** Keeps Moodle and Go unchanged and the integration independently deployable.
Code inspection showed the Go service (`bihasa-moodle-go`) owns no data of its own — it reads
and writes the Moodle database — so a Go connector would add nothing for learning data.

**Cost.** No activity history (only last access) and no bulk completion. Accepted for the
MVP; see ROADMAP for snapshots / plugin.

## ADR-002 — One deployment per tenant ("cell"), Preview = staging

**Decision.** One Vercel project per tenant; Preview (branch `release`) is staging,
Production (branch `main`) is prod. Same env var names everywhere; tenant config is code.

**Why.** One process never holds two clients' credentials; the shared-key auth cannot
safely carry tenant identity; Claude connector auth is immutable, so stable per-environment
URLs matter. Code is tenant-parametrised so a multi-tenant deployment remains possible once
OAuth provides tenant claims.

**Trade-off.** Staging and prod share project-level settings (region, protection). Vercel
Custom Environments would separate them if the plan includes them.

## ADR-003 — Shared `x-api-key` for the POC, no OAuth yet

**Decision.** Claude sends a fixed `x-api-key` request header configured by an org Owner;
the server checks it (constant-time, SHA-256) against `MCP_ACCESS_KEY` before any MCP
processing and answers 401 without a `WWW-Authenticate` challenge.

**Why `x-api-key` and not `X-MCP-Key`.** Claude only sends custom header names that
Anthropic has approved; `x-api-key`, `x-auth-token` and `authorization` are pre-approved.

**Limits.** Org-wide credential, no per-user identity or authorisation, rotation requires
re-adding the connector. Production direction: OAuth 2.1 (CIMD/DCR, PKCE), per-user scope.

## ADR-004 — Profile values verbatim; empty = "N/A"

**Decision.** Region, Dealer Level and Branch are reported exactly as stored in the Moodle
profile (`Region_Dropdown`, `level`, `branch_code`); empty → `N/A`. Branch keeps its full
label and exposes parsed name and code. No catalog-derived region.

**Why.** The profile is the business source of truth; legacy values are refreshed
programmatically on sign-in, so stale values mostly mark inactive accounts.

## ADR-005 — Dealer rule = student + Conso ID − exclusions (superseded by ADR-008)

**Decision.** A Dealer is an actively enrolled `student` with a Conso ID (`dealer_conso_id`
or Conso-shaped username), not holding `redemptionmanager`, not in the excluded username
list (staging: UAT pool).

**Why.** Matches "remove dummy/admin/non-dealer accounts" using profile data; staff and
admins have no Conso ID.

## ADR-006 — Honest time windows

**Decision.** Windows ending now are exact. Past ranges are returned with
`semantics: last_access_in_range` and a warning, never presented as "accessed during".

**Why.** The API exposes only the most recent access; silently treating it as history would
undercount active periods.

## ADR-007 — Named engagement signals; "started" is the default course signal (2026-11-04)

**Decision.** Replace the single "accessed" metric with named signals: `started`,
`completion`, `site_last_access`, `web_course_access`, `avg_score`. `started` (progress > 0
or completed) is the default per-course signal; `web_course_access` is always labelled
web-only.

**Why.** Verified on staging: opening a course in the mobile app leaves Moodle's per-course
last access empty (a Dealer with 2 completed courses had none recorded on any of 27), while
completing an activity in the app moves progress. Course access as "last access" reported
≈ 0.5% for a production copy — a measurement artefact, not engagement.

**Cost.** `started`/`completion` need one call per person (capped at 300 per answer);
opening without completing is invisible without the activity log.

## ADR-008 — Three identity statuses: dealer / legacy / excluded (2026-11-04)

**Decision.** Every account gets one status. Dealer = 12-char Conso ID after normalisation
(trim, lower-case, 11→12 digits); legacy = missing or old/malformed ID; excluded = role,
test, staff (`PC Center of Excellence`), dummy patterns. Dealers count once per Conso ID.
Callers choose the population; counts per status come with every answer.

**Why.** Sampled on staging: canonical `BBBB+8 digits` and PC alphanumeric IDs are genuine;
staff are identified by Dealer Level, not ID shape; duplicate accounts exist (same ID with a
dropped zero); placeholder IDs (`0`, `111111111111`, `123123123123`) were counted as Dealers
under ADR-005, and thousands of legacy accounts were silently dropped.

## ADR-009 — Nothing stored; large answers in parts via a signed cursor (2026-11-04)

**Decision.** No datastore. Enrolment-level questions that do not fit one call are answered
in parts: the response carries a signed cursor with progress and running totals; Claude calls
again until complete.

**Why.** Business preference for fresh data and no copies of personal data outside Moodle.
A nightly precomputed store was considered and rejected; Moodle-side aggregation (read-only
plugin) is the route for org-wide speed and history.

## ADR-010 — General-purpose tools, not dashboard-shaped endpoints (2026-11-04)

**Decision.** Six capabilities (describe, catalogue, dimension values, metrics query, people
list, person detail) combined by Claude, instead of one tool per dashboard card/menu.

**Why.** The COE dashboard asks are the test of coverage, not the design. A metric/dimension
layer serves other clients and questions without new tools.
