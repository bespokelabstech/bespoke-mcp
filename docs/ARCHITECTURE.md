# Architecture

## Goal

A standalone, reusable integration service that exposes **business capabilities** (not raw
tables) of client systems to enterprise AI assistants over MCP. First tenant: **GLA**
(PC GLASS dealer network on the Bihasa Moodle). Designed so a second system (e.g. the Go
API or the PC dealer API) or a second client can be added without restructuring.

## Request path

```
Claude custom connector
  │  POST /api/mcp  (Streamable HTTP, stateless; header x-api-key)
  ▼
app/api/mcp/route.ts
  1. getRuntimeConfig()      env + tenant config + guardrails   → 500 if invalid (fail closed)
  2. isAuthorized()          constant-time x-api-key check      → 401, no WWW-Authenticate
  3. mcp-handler 2.x         createMcpHandler(registerTools)
       └─ tools/*            6 tools: zod schema → runTool() (budget, logging, diagnostics, safe errors)
            └─ domain/*      identity status, signals, dimensions, windows, aggregation (pure)
                 └─ ports/learning.ts   LearningDataPort (system-neutral)
                      └─ connectors/moodle   REST WS client + adapter (core read functions)
```

## Layers

| Layer          | Path                      | Knows about                           | Must not                 |
| -------------- | ------------------------- | ------------------------------------- | ------------------------ |
| Transport/auth | `app/api/mcp`, `src/core` | HTTP, MCP, env                        | contain business rules   |
| Tools          | `src/tools`               | MCP schemas, domain, ports            | call connectors directly |
| Domain         | `src/domain`              | tenant config, port types             | know Moodle, HTTP or MCP |
| Ports          | `src/ports`               | neutral data shapes                   | —                        |
| Connectors     | `src/connectors/*`        | one external system                   | contain business rules   |
| Tenants        | `src/tenants/<id>`        | client field names, rules, guardrails | contain secrets          |

## Tenancy model

- **Tenant** = one client's data scope (`gla`). Config is code in `src/tenants/<id>/`:
  `base.ts` + environment overlays `staging.ts` / `production.ts` (deep-merged; arrays in an
  overlay replace the base array).
- **Cell deployment**: each Vercel project serves exactly **one tenant**; its Preview
  environment (branch `release`) is staging and Production (branch `main`) is prod.
  Same env var **names** everywhere; only values differ. See `docs/DEPLOYMENT.md`.
- Why cells, not one multi-tenant deployment: blast-radius isolation (one process never
  holds two clients' credentials), the shared-key auth cannot safely identify a tenant,
  and Claude connector auth cannot be edited after creation. The code is tenant-parametrised
  (`ToolDeps.tenant`), so consolidating later (with OAuth tenant claims) is a deployment
  change, not a rewrite. See ADR-002.

## Tools

General-purpose capabilities; titles and descriptions use the tenant's vocabulary.

| Tool                    | Purpose                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `describe_capabilities` | BES-465 glossary with connector notes, saved filter, defaults, signals, sortable columns, limits      |
| `list_courses`          | Course catalogue                                                                                      |
| `list_dimension_values` | Region / level / branch values as stored, with counts                                                 |
| `query_metrics`         | Signals × grouping × filters × date range × saved filter × sort; answers in parts via a signed cursor |
| `list_people`           | Accounts in one course: same filter contract, a metric filter, search, sort on any column             |
| `get_person`            | One account by username with every in-scope course                                                    |

Metric names, defaults, filters and sort follow BES-465 (ADR-011). Who counts = base scope
(learner roles, `tenant.accounts`) + the default saved filter (`tenant.savedFilters`,
`tenant.defaults`), evaluated in `src/domain/people.ts`; the filter contract is resolved in
`src/tools/shared-schemas.ts`. The BES-465 glossary lives in `src/domain/glossary.ts`.

## Ports and connectors

`LearningDataPort` (`src/ports/learning.ts`) is the only thing domain code depends on.

| Port                           | Adapter now                                                               | Possible later                                                                      |
| ------------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `LearningDataPort`             | `MoodleLearningAdapter` (core WS), `FixtureLearningAdapter` (local/tests) | Moodle + read-only plugin for history; other LMS                                    |
| `RewardsDataPort` (future)     | —                                                                         | Moodle (redemptions/coins live in Moodle tables) or Go API if it gains service auth |
| `DealerDirectoryPort` (future) | —                                                                         | PC dealer API (identity lookup by Conso ID)                                         |

A future port registers its tools only for tenants that bind it.

## Moodle connector

- Core read functions only (list in `docs/MOODLE_SETUP.md`); no Moodle plugin required.
  Optional functions (grade report) are detected via `core_webservice_get_site_info`.
- Token sent in the POST body; never in URLs or logs.
- **Two-pass pull.** `core_enrol_get_enrolled_users` is paged (`limitfrom`/`limitnumber`,
  sorted by id) and requests only `id,username,firstname,lastname,roles,lastaccess,lastcourseaccess`
  — no custom fields, which are the expensive part. Profiles are then fetched **once per
  account** with `core_user_get_users_by_field` (field `id`, batches of 100) and reused across
  courses. That call cannot limit fields, so email etc. pass through memory and are dropped.
- **Nothing persisted.** A per-instance in-memory cache (default 5 min, `cacheTtlSeconds`,
  0 = off) avoids re-pulling within one conversation.
- Bounded concurrency (`limits.upstreamConcurrency`, 2) and a per-tool time budget
  (`limits.requestBudgetMs` < Vercel `maxDuration` 60 s).
- **Answers in parts.** `query_metrics` picks single / pages / people mode. Pages: the work
  unit is one enrolment page of one course (so a 6K-enrolment course splits mid-course);
  people: per-person signals always run in batches of people (one call when small), ordered
  by counting key so duplicate accounts stay together and resumed by the last processed key
  (stable if enrolments change between parts). The cursor is base64url
  JSON (position + additive partial sums packed as positional arrays; size checked before each
  further unit of work), HMAC-signed with a key derived from the access key
  and bound to a hash of the query. A timeout while reading a Moodle body is reported as a
  timeout, and a part that runs out of time returns what it finished plus the cursor. A Moodle
  call limited by the remaining request budget reports `scope_too_large`; one limited by
  `MOODLE_TIMEOUT_MS` reports `upstream_unavailable`.
- Moodle's fixed reason for course-access failures ("User not fully set-up", "Site policy not
  agreed") is surfaced with a hint; free-text messages are otherwise never forwarded.

## Security boundaries

| Boundary                            | Control                                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Who can call the MCP endpoint       | `x-api-key` (shared org key, POC) → OAuth later (ROADMAP)                                                   |
| What the server can read in Moodle  | Dedicated service account + external service with only read functions                                       |
| Which Moodle a deployment can reach | `moodleAllowedHosts` per environment, checked at startup                                                    |
| Prod credentials on previews        | `MCP_ENV` ↔ `VERCEL_ENV` + branch check at startup; `vercel.json` deploys only `main`/`release`             |
| Data minimisation                   | Adapter requests only needed user fields; outputs carry names, Conso ID and profile values — no email/phone |
| Logs                                | JSON lines; no headers, bodies, tokens or personal data; sensitive field names redacted                     |
| Synthetic data                      | `MCP_DATA_SOURCE=fixture` refused on Vercel                                                                 |

**Personal data:** staging is rebuilt from production, so it contains real dealer names and
Conso IDs. Per-person tools (`list_people`, `get_person`) show these to anyone
in the Claude org holding the connector. This was accepted for the POC; OAuth with
per-user authorisation is the production answer.

## Logging

One JSON object per line: `ts, level, event, tenant, env, request_id` plus event fields.
Events: `http.request`, `auth.rejected`, `config.invalid`, `tool.ok`, `tool.error`,
`moodle.retry`, `moodle.call` (debug). Tool logs record argument **keys**, timings and
upstream call counts — never argument values or results.

## Known limits (MVP, standard API only)

- **App activity is invisible per course** except through progress/completion. Opening a
  course or partly viewing an activity in the app leaves no trace the API exposes.
- **History:** only the last access is kept; past windows are labelled `last_access_in_range`.
- **Per-account signals** (`accessed`, `progress`) need one call per account and run in
  batches (≈ 0.5–1 s per account on staging at concurrency 2), so large scopes take several parts.
  `list_people` filtered or sorted by `accessed`/`progress` is limited to 300 accounts.
- **Org-wide distinct-people answers** across many courses may not fit one call.
- A read-only Moodle plugin (aggregates, activity log, history) lifts all four — ROADMAP.
- System-level roles are not visible through course data; COE staff are excluded by the default
  Dealer Level exclude list.
