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

## ADR-011 — Align names, defaults, filters and sort with BES-465 (2026-11-09)

**Decision.** The connector uses the BES-465 (Compliance Dashboard v2) glossary, filter
contract, defaults and sort, while still reading Moodle live and never calling the dashboard or
its API. Supersedes the naming in ADR-007 and the statuses in ADR-008.

- Names: `started` → `accessed`, `site_last_access` → `logged_in` (metric) / `last_sign_in`
  (column), `completion` → `progress` (progress, completed, avg. completion ÷ enrolled),
  `since`/`until` → `from`/`to`, `population` → `valid_only`, `count_by: people` → `accounts`.
  No aliases: tool inputs are strict, so an old argument name fails loudly instead of being
  silently ignored.
- Base scope: learner accounts only (student, no trainer/admin role, incl. redemption manager).
- Saved filter `valid_dealers` in tenant config, on by default; `in`/`not_in`/`matches`/`equals`
  over identity fields only (username, Conso ID, name). Provisional rules: dummy Conso ID /
  username patterns.
- COE is a **level default** (exclude `PC Center of Excellence`), not a saved-filter rule —
  BES-465 forbids saved-filter conditions on fields that have their own filter.
- Every account counts on its own: no merging of duplicate accounts and no leading-zero repair.
  No format rule: legacy/old-format accounts are valid dealers unless a rule rejects them.
- Include and exclude lists for region, level, branch and category; `group_by` category; sort on
  any column (rows come with the last part so they can be sorted).
- `describe_capabilities` carries the glossary word for word, plus an "in this connector" note
  per term where this connector measures it differently or cannot.

**Why.** People will compare the connector's numbers with the dashboard's. Same labels with
different rules would make every mismatch look like a bug. Merging and ID repair cannot be
written in BES-465's filter format, so keeping them would guarantee differences; the business
also decided Conso IDs are never edited or reinterpreted (2026-11-09).

**Cost.** Valid-dealer totals move versus mvp3: duplicate accounts now count twice, 11-digit and
legacy-format accounts now count, COE is excluded by a default instead of a status. The known
gaps (Logged in within past ranges, Accessed within a range, sessions, region source) remain
until the connector can read BES-465's reporting API (ROADMAP, phase B).

## ADR-012 — `valid_dealers` = BES-465's 7 hide rules; no default level exclude (2026-11-09)

**Decision.** BES-465 was updated with the GLA rules (from Jona's eligibility sheet). The saved
filter is now one list of rules; an account matching at least one is hidden. Fields: username,
Conso ID, name, email (domain only), account status, and Dealer Level (BES-465's deliberate
exception). The 7 rules are internal email domain, test/training/admin username, test or dummy
name, dummy Conso ID (in the username), placeholder name, suspended, COE or blank level. The
default level exclude from ADR-011 is removed: every other filter defaults to "all". Empty
profile values show as "Not set" (BES-465 wording). Supersedes the saved-filter part of ADR-011.

**Why.** Same rules as the dashboard, so "Valid dealers" means the same number in both. Renzel
has not started the custom-API side, so Bespoke wrote the patterns from the rule table; they
can become the shared definition.

**Cost / risks.** The connector now reads email addresses, but keeps only the domain in the
Moodle adapter — never returned, logged or cached in full. If Moodle hides emails from the
service account, rule 1 cannot apply; every answer warns. Patterns for rules 4 and 5 are
guesses (METRICS lists them). The previous dummy check on the Conso ID profile field and the
repeated 2–3 digit block pattern are dropped because BES-465 does not have them.

## ADR-013 — Rule 5 reported per part; unknown names are not blank (2026-11-09)

**Decision.** The three parts of BES-465 rule 5 (blank name, "PC SFLMS Live", legacy username
at the start) keep separate labels, and `population.matched_by_rule` adds overlapping counts
next to the first-match `not_valid`. A name the LMS did not return skips the name rules and
raises a warning instead of counting as blank.

**Why.** On staging one Course showed 136 of 778 accounts hidden by rule 5, and one label could
not say which part (or whether missing data) caused it. The dashboard's single "Placeholder
name" count equals the sum of the three labels; `not_valid_because` may list more than one part.
