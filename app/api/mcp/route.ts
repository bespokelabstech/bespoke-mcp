import { isAuthorized, unauthorizedResponse } from "@/core/auth";
import { getRuntimeConfig } from "@/core/env";
import { toAppError } from "@/core/errors";
import { log } from "@/core/logger";
import { newRequestState, requestContext } from "@/core/request-context";
import type { McpRequestHandler } from "@/core/server";
import { buildLearningPort, buildMcpHandler } from "@/core/server";

/**
 * Remote MCP endpoint (Streamable HTTP, stateless). Order of checks:
 *   1. runtime config valid (fail closed: 500, details only in logs)
 *   2. x-api-key valid (401 before the MCP SDK sees the request)
 *   3. MCP handler
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel function ceiling. Tool budgets (tenant.limits.requestBudgetMs) stay below it.
export const maxDuration = 60;

let handler: McpRequestHandler | undefined;

async function handle(req: Request): Promise<Response> {
  const state = newRequestState(55_000, req.headers.get("x-vercel-id") ?? undefined);
  return requestContext.run(state, async () => {
    const started = Date.now();
    let cfg;
    try {
      cfg = getRuntimeConfig();
    } catch (err) {
      const e = toAppError(err);
      log.error("config.invalid", { message: e.message, ...e.logFields });
      return Response.json({ error: "server_misconfigured" }, { status: 500 });
    }
    if (!isAuthorized(req.headers, cfg.accessKeys)) {
      log.warn("auth.rejected", { method: req.method, key_header_present: req.headers.has("x-api-key") });
      return unauthorizedResponse();
    }
    handler ??= buildMcpHandler(cfg, buildLearningPort(cfg));
    try {
      const res = await handler(req);
      log.info("http.request", { method: req.method, status: res.status, ms: Date.now() - started });
      return res;
    } catch (err) {
      const e = toAppError(err);
      log.error("http.error", { code: e.code, ...e.logFields });
      return Response.json({ error: "internal_error" }, { status: 500 });
    }
  });
}

export { handle as GET, handle as POST, handle as DELETE };
