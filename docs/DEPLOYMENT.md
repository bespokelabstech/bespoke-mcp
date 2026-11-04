# Deployment (Vercel)

One repo, **one Vercel project per tenant**. In each project:

| Vercel environment | Git branch     | Purpose                     | Domain                                  |
| ------------------ | -------------- | --------------------------- | --------------------------------------- |
| Preview            | `release` only | Staging / release candidate | `<tenant>-staging.mcp.bespokelabs.tech` |
| Production         | `main`         | Production                  | `<tenant>.mcp.bespokelabs.tech`         |

`vercel.json` disables deployments for every other branch and PR, so feature branches never
build on Vercel (CI still runs on PRs). **[verify on first deploy]** that the `"*": false`
pattern is honoured; fallback: _Settings → Git → Ignored Build Step_ with
`[ "$VERCEL_GIT_COMMIT_REF" != "main" ] && [ "$VERCEL_GIT_COMMIT_REF" != "release" ]`
(exit 0 = skip build).

## Release flow

1. `feature/*` → PR into `release` (CI: typecheck, lint, format, tests, build).
2. Merge → **every tenant's staging** redeploys. Validate (smoke test + Claude staging connector).
3. PR `release` → `main` → **every tenant's production** redeploys.
4. Problem in prod: Vercel → project → Deployments → previous deployment → **Instant Rollback**.

## Environment variables

Names are identical in every project; only values differ. Set them under
**Project → Settings → Environment Variables**. Mark secrets **Sensitive**.

| Name                  | Preview (branch `release`)      | Production                 | Notes                                                                            |
| --------------------- | ------------------------------- | -------------------------- | -------------------------------------------------------------------------------- |
| `MCP_TENANT`          | `gla`                           | `gla`                      | Folder in `src/tenants/`                                                         |
| `MCP_ENV`             | `staging`                       | `production`               | Must match the Vercel environment (startup check)                                |
| `MCP_ACCESS_KEY`      | staging key                     | **different** prod key     | ≥ 32 chars; `openssl rand -base64 32`; same value goes into the Claude connector |
| `MCP_ACCESS_KEY_NEXT` | —                               | —                          | Only during key rotation                                                         |
| `MOODLE_BASE_URL`     | `https://gla-staging.bihasa.ph` | `https://gla.bihasa.ph`    | Host must be in the tenant allow-list                                            |
| `MOODLE_WS_TOKEN`     | staging service-account token   | prod service-account token | `docs/MOODLE_SETUP.md`                                                           |
| `MOODLE_TIMEOUT_MS`   | optional                        | optional                   | default 15000                                                                    |
| `LOG_LEVEL`           | optional                        | optional                   | `debug`/`info`/`warn`/`error`                                                    |

**Preview variables must be scoped to branch `release`.** When adding a Preview variable,
choose _Preview_ → _Select a custom branch_ → `release`. Leaving it on "All Preview branches"
would hand the staging Moodle token to any preview build (the `vercel.json` branch filter is
the second line of defence).

Never set secrets for the _Development_ environment. Never set `MCP_DATA_SOURCE` on Vercel
(startup refuses it).

Vercel applies env changes **only to new deployments** — redeploy after any change.

### Startup guardrails (server answers 500 until fixed; reason in logs as `config.invalid`)

- `MCP_ACCESS_KEY` missing or < 32 chars.
- Unknown `MCP_TENANT`, or `MCP_ENV` not defined for that tenant.
- `MCP_ENV=production` on a non-production deployment, or `MCP_ENV=staging` on a preview
  from a branch other than `release`.
- `MOODLE_BASE_URL` not https, or host not in the tenant's allow-list for that environment.
- Only one of `MOODLE_BASE_URL` / `MOODLE_WS_TOKEN` set.

Without Moodle variables the server still runs: tools are listed and return
`not_configured`. This lets you add and test the Claude connector before the Moodle token exists.

## Create the project for a tenant (example: `gla`)

1. **Vercel → Add New → Project → Import** `bespokelabstech/bespoke-mcp`.
   - Project name: `mcp-gla`. Framework: Next.js (auto). Root directory: `./`.
   - Do not add env vars on the import screen; do it in step 3 with branch scoping.
2. **Settings → Git**: Production Branch = `main`.
3. **Settings → Environment Variables**: add the table above (Preview scoped to `release`).
4. **Settings → Functions → Function Region**: `Singapore (sin1)` (close to the GLA Moodle).
   Region is per project on purpose — do **not** put `regions` in `vercel.json`, which
   applies to every tenant.
5. **Settings → Deployment Protection**: turn **Vercel Authentication off** for this project.
   Claude cannot pass Vercel's login, so a protected preview would make the staging connector
   fail. Safe because only `main`/`release` deploy and every MCP request needs `x-api-key`.
6. **Settings → Domains**:
   - Add `gla.mcp.bespokelabs.tech` → Production.
   - Add `gla-staging.mcp.bespokelabs.tech` → assign to **Git branch `release`**.
   - At the DNS provider for `bespokelabs.tech`, create the **CNAME** records Vercel shows for
     each domain. Use custom domains (not `*.vercel.app`) so the connector URL never changes —
     Claude connector settings cannot be edited after creation.
7. Deploy: push/merge to `release` (staging) or `main` (production), or _Redeploy_ from the
   dashboard after setting env vars.

## Smoke test

```bash
URL=https://gla-staging.mcp.bespokelabs.tech
read -rs KEY   # paste MCP_ACCESS_KEY, not echoed, not in shell history

curl -s $URL/api/health                                   # {"status":"ok"}
H=(-H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'mcp-protocol-version: 2025-06-18')
curl -s -o /dev/null -w '%{http_code}\n' "${H[@]}" -X POST $URL/api/mcp \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'     # 401
curl -s "${H[@]}" -H "x-api-key: $KEY" -X POST $URL/api/mcp \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'     # 6 tools
curl -s "${H[@]}" -H "x-api-key: $KEY" -X POST $URL/api/mcp \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_courses","arguments":{}}}'
```

Or interactively: `npx @modelcontextprotocol/inspector` → Streamable HTTP → URL `$URL/api/mcp`
→ header `x-api-key`.

## Key rotation

Claude connector auth cannot be edited, so rotation is: remove + re-add the connector.

1. Generate a new key; set it as `MCP_ACCESS_KEY_NEXT`; redeploy (both keys now work).
2. In Claude, remove the connector and add it again with the new key (members reconnect).
3. Move the new key to `MCP_ACCESS_KEY`, delete `MCP_ACCESS_KEY_NEXT`; redeploy.

Rotate the Moodle token the same way in Moodle (new token, update env, redeploy, delete old).

## Logs

Vercel → project → Logs. Filter on `event` (`tool.ok`, `tool.error`, `auth.rejected`,
`config.invalid`) and `env`. Both environments share one project's logs; every line carries `env`.
