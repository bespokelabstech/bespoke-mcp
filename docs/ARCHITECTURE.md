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
       └─ tools/*            zod input schema → runTool() (budget, logging, safe errors)
            └─ domain/*      eligibility, dimensions, windows, aggregation (pure)
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
- Token sent in the POST body; never in URLs or logs.
- `core_enrol_get_enrolled_users` is paged (`limitfrom`/`limitnumber`, sorted by id) and
  requests only `id,username,firstname,lastname,roles,customfields,lastcourseaccess`.
- Per-instance TTL cache (default 15 min) for course lists and participant pulls, with
  in-flight de-duplication. No external store.
- Bounded concurrency (`limits.upstreamConcurrency`) and a per-tool time budget
  (`limits.requestBudgetMs` < Vercel `maxDuration` 60 s). Exceeding it returns
  `scope_too_large` asking the user to narrow the question.

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
Conso IDs. Per-dealer tools (`get_course_access`, `get_dealer_access`) show these to anyone
in the Claude org holding the connector. This was accepted for the POC; OAuth with
per-user authorisation is the production answer.

## Logging

One JSON object per line: `ts, level, event, tenant, env, request_id` plus event fields.
Events: `http.request`, `auth.rejected`, `config.invalid`, `tool.ok`, `tool.error`,
`moodle.retry`, `moodle.call` (debug). Tool logs record argument **keys**, timings and
upstream call counts — never argument values or results.

## Known limits (MVP)

- History: the Moodle API exposes only the **last** access per person/course. Windows
  ending now are exact; past windows are labelled `last_access_in_range`. True history needs
  snapshots or a plugin (ROADMAP).
- Completion at org scale needs one call per person; live completion is capped at
  `limits.maxPeopleForCompletion` (300).
- System-level roles are not visible through course participant data; non-dealers are
  excluded by the identifier rule, course roles and explicit username exclusions.
