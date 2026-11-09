# Roadmap (not in the MVP)

## BES-465 alignment

- **Phase A — done in 0.4.0:** same names, defaults, filters and sort as BES-465, still read
  live from Moodle (ADR-011).
- **Phase B — later, not scheduled:** a `reporting` connector that reads BES-465's read-only
  reporting API (`/reporting/v1`, service token) behind the same tools. It would make Logged in
  within a range, Accessed within a range, Sessions, Days active, First/Last progress and Region
  from Branches & Regions exact, with sub-second answers. The Moodle connector stays for
  drill-downs and as a fallback. Needs: the API shipped, a read-only service token, and the
  saved-filter JSON shared between both systems so `valid_dealers` cannot drift.
- **Open with the GLA team / Renzel:** the confirmed `valid_dealers` rules (e.g. suspended
  accounts — needs the account status field here too), and the saved-filter JSON shape
  (this connector uses `require` / `reject` lists of conditions).

## Other items

| Item                                                                                                                                                                                  | Unlocks                                                                                                                                  | Needs                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Read-only Moodle plugin** (aggregates over completions, `logstore_standard_log`, grades; no tables, no personal data in responses) — largely superseded by phase B if BES-465 ships | Org-wide answers in seconds; activity-log engagement including mobile app views; true history incl. backfill; bulk completion and scores | Plugin install per Moodle environment (Bihasa); the connector detects it and the same tools gain the data                              |
| Rewards port (redemptions, coins)                                                                                                                                                     | "Completion vs redemption" questions                                                                                                     | Data lives in Moodle tables (`local_marketplace_redemption`, `local_points_ledger`): plugin functions, or the Go API with service auth |
| Dealer directory port (PC dealer API)                                                                                                                                                 | Identity enrichment by Conso ID                                                                                                          | `PCAPI_BASE_URL`, `PCAPI_KEY`                                                                                                          |
| OAuth 2.1                                                                                                                                                                             | Per-user identity, authorisation (e.g. regional scope), audit                                                                            | Authorization server with CIMD/DCR + PKCE; JWT validation; durable audit log                                                           |
| Tenant-level hold on prod releases                                                                                                                                                    | Pin a tenant to an older version                                                                                                         | Ignored-build-step variable per project                                                                                                |

Rejected: a nightly snapshot store (ADR-009) — it would keep copies of per-person data outside
Moodle and still inherit the mobile-app blind spot of last-access fields.
