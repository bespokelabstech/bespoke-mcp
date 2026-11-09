# Adding a tenant

Example: a second Bihasa client on its own Moodle, tenant id `acme`.

## 1. Code (PR into `release`)

1. Copy `src/tenants/gla/` to `src/tenants/acme/` and edit:
   - `base.ts`: `id`, `displayName`, `timezone`, `vocabulary` (e.g. `Learner`), the three
     `dimensions` (that client's profile field shortnames — verify them in its Moodle under
     _Users → User profile fields_), `identity` (label + profile field), `accounts` (learner
     and non-learner course roles), `savedFilters` (the client's rules over username / ID /
     name — sample real IDs first, as done for GLA) and `defaults` (default saved filter,
     default exclude lists), `scoring`, `courses`, `limits`,
     `environments.*.moodleAllowedHosts`.
   - `staging.ts` / `production.ts`: environment-only differences (test accounts, hosts).
2. Register it in `src/tenants/registry.ts` (`const TENANTS = { gla, acme }`).
3. Add a test that `loadTenant("acme", "staging")` and `("acme", "production")` validate.
4. `npm run check && npm run build`; update `docs/CHANGELOG.md`.

If the client needs a dimension that is not region / level / branch, extend
`tenantConfigSchema.dimensions` and the tool schemas — keep names generic.

## 2. Moodle (per environment)

Follow `docs/MOODLE_SETUP.md` on the client's Moodle.

**Shared Moodle with several companies** (e.g. filtered by a `company_code` profile field):
a Moodle token cannot be limited to one company, so isolation would rely only on our filter.
Do not onboard such a client without a per-company Moodle service or a server-side
restriction — raise it as a decision first.

## 3. Vercel

`docs/DEPLOYMENT.md` → "Create the project for a tenant", with project `mcp-acme`,
domains `acme.mcp.bespokelabs.tech` / `acme-staging.mcp.bespokelabs.tech`, and the region
closest to the client's Moodle.

## 4. Claude

Add two connectors (`docs/CLAUDE_CONNECTOR.md`) with that project's keys — in whichever
Claude organisation will use them.
