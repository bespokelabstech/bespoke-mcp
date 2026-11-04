# Claude custom connector

Each tenant environment is a separate connector, e.g. **"GLA LMS (Staging)"** and **"GLA LMS"**.

## Requirements

- An **Owner** of the Bespoke Claude organisation (Enterprise: or a custom role with
  _Manage access to Libraries_).
- The **Request headers** section must appear in the _Add custom connector_ dialog. It is a
  beta available to a limited set of organisations; if it is missing, request access from
  Anthropic support. (OAuth is on the roadmap as the long-term alternative.)
- We use the standard header name `x-api-key`, which needs no Anthropic approval.

## Add (Owner)

1. **Organization settings → Connectors → Add → Custom → Web**.
2. Name: `GLA LMS (Staging)`. URL: `https://gla-staging.mcp.bespokelabs.tech/api/mcp`.
3. Authentication: **No sign-in**.
4. Request headers: name `x-api-key`, value = the environment's `MCP_ACCESS_KEY`
   (raw value, no `Bearer` prefix), **Required**.
5. **Add**.

Repeat for production with `https://gla.mcp.bespokelabs.tech/api/mcp` and the production key.

## Use (members)

**Customize → Connectors** → the _Custom_ connector → **Connect**. In a chat:
**+ → Connectors** → enable it.

## Notes

- Authentication settings cannot be edited; changing the key means remove + re-add
  (see key rotation in `docs/DEPLOYMENT.md`).
- Everyone using the connector shares one key; the server cannot tell members apart.
- Every response states `environment`; do not mix staging and production in one analysis.

## Demo prompts

1. "For Revitalife Maqui Berry, how many Dealers have started it, by Region? Which Regions look alike and are separate values?"
2. "List the Great Life Builders in Visayas 3 who have not started Revitalife Maqui Berry."
3. "Per Course, how many Dealers used the app in the last 30 days, and what's the average quiz score?" (answered in parts)
4. "How many enrolled accounts are Legacy or Excluded in Kwentong Great Life, and why?"
