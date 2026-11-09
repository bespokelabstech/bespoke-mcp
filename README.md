# bespoke-mcp

Bespoke's standalone, read-only **business-aware MCP server**. It lets Claude (via a
custom connector) answer business questions over client systems — starting with
**GLA (PC GLASS) learning data in Moodle** — using deterministic, server-computed metrics.

```
Claude (custom connector, x-api-key) ──HTTPS──▶ Vercel: /api/mcp (this repo)
                                                  ├─ x-api-key guard (401 before MCP runs)
                                                  ├─ tools  ─▶ domain services (metrics, rules)
                                                  ├─ tenant config (field mappings, dealer rule)
                                                  └─ ports ─▶ connectors: Moodle REST [now] · Go / PC API [later]
```

- One codebase, deployed **once per tenant** (Vercel project), with **Preview = staging**
  (branch `release`) and **Production = prod** (branch `main`).
- Everything client-specific lives in `src/tenants/<id>/`; secrets live only in Vercel env vars.
- Read-only by construction: the Moodle token's web service contains only read functions,
  and every tool is annotated `readOnlyHint: true`.

## Tools

| Tool                    | Answers                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `describe_capabilities` | Glossary (BES-465, with connector notes), saved filter, defaults, signals, sortable columns, limits      |
| `list_courses`          | Course catalogue (id, name, category, completion tracked)                                                |
| `list_dimension_values` | Region / Dealer Level / Branch values as stored, with account counts                                     |
| `query_metrics`         | Logged in, Accessed, Access rate, Progress, Completed, web access, avg score × grouping × filters × sort |
| `list_people`           | Dealers in a Course: profile values, valid or not, last sign-in, progress — filterable and sortable      |
| `get_person`            | One account by username: every Course with accessed / progress / completed                               |

Metric definitions: [`docs/METRICS.md`](docs/METRICS.md).

## Quick start (local, synthetic data)

```bash
nvm use            # Node 22
npm ci
cp .env.example .env.local
# set MCP_ACCESS_KEY (openssl rand -base64 32) and MCP_DATA_SOURCE=fixture
npm run dev
# then, in another shell:
npx @modelcontextprotocol/inspector   # URL http://localhost:3000/api/mcp, header x-api-key
```

`MCP_DATA_SOURCE=fixture` serves deterministic synthetic data (no Moodle needed) and is
refused on Vercel.

## Commands

| Command                           | What                                           |
| --------------------------------- | ---------------------------------------------- |
| `npm run dev` / `build` / `start` | Next.js                                        |
| `npm run check`                   | typecheck + lint + tests (run before every PR) |
| `npm run format`                  | Prettier                                       |

## Docs

| Doc                                          | For                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| [ARCHITECTURE](docs/ARCHITECTURE.md)         | Layers, ports, tenancy model, security boundaries                          |
| [METRICS](docs/METRICS.md)                   | Every metric definition and its source — **review before quoting numbers** |
| [DEPLOYMENT](docs/DEPLOYMENT.md)             | Vercel setup per tenant, env vars, domains, release flow, key rotation     |
| [MOODLE_SETUP](docs/MOODLE_SETUP.md)         | Restricted Moodle service account + token                                  |
| [CLAUDE_CONNECTOR](docs/CLAUDE_CONNECTOR.md) | Adding the connector in the Claude workspace                               |
| [ADDING_A_TENANT](docs/ADDING_A_TENANT.md)   | Onboarding another client                                                  |
| [DECISIONS](docs/DECISIONS.md)               | Architecture decision log                                                  |
| [ROADMAP](docs/ROADMAP.md)                   | What is deliberately not in the MVP                                        |
| [CHANGELOG](docs/CHANGELOG.md)               | Changes                                                                    |
