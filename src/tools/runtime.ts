import type { CallToolResult } from "@modelcontextprotocol/server";
import { AppError, toAppError } from "@/core/errors";
import { log } from "@/core/logger";
import { newRequestState, requestContext } from "@/core/request-context";
import type { LearningDataPort } from "@/ports/learning";
import type { EnvironmentName, TenantConfig } from "@/tenants/schema";

/** What every tool receives. Tools never construct connectors themselves. */
export interface ToolDeps {
  tenant: TenantConfig;
  env: EnvironmentName;
  /** null when this deployment has no LMS credentials yet. */
  learning: LearningDataPort | null;
  nowSec: () => number;
  /** Signs continuation cursors (derived from the access key; never sent anywhere). */
  cursorSecret: string;
}

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function requireLearning(deps: ToolDeps): LearningDataPort {
  if (!deps.learning) {
    throw new AppError(
      "not_configured",
      "The LMS connection is not configured for this deployment yet (MOODLE_BASE_URL / MOODLE_WS_TOKEN).",
    );
  }
  return deps.learning;
}

/** Remaining time in this tool call's budget, in ms. */
export function remainingBudgetMs(): number {
  const ctx = requestContext.get();
  return ctx ? ctx.deadline - Date.now() : Number.POSITIVE_INFINITY;
}

/**
 * Wrap a tool body: per-call time budget, structured logging, diagnostics on the result, and
 * conversion of any failure into a safe `isError` result (never a stack trace or upstream payload).
 */
export async function runTool(
  name: string,
  deps: ToolDeps,
  args: Record<string, unknown>,
  body: () => Promise<unknown>,
): Promise<CallToolResult> {
  const parent = requestContext.get();
  const state = newRequestState(deps.tenant.limits.requestBudgetMs, parent?.requestId);
  return requestContext.run(state, async () => {
    const started = Date.now();
    const diagnostics = () => ({ ms: Date.now() - started, lms_calls: state.upstreamCalls });
    try {
      const result = await body();
      const out =
        result && typeof result === "object" && !Array.isArray(result)
          ? { ...(result as Record<string, unknown>), diagnostics: diagnostics() }
          : result;
      log.info("tool.ok", {
        tool: name,
        arg_keys: Object.keys(args).filter((k) => args[k] !== undefined),
        ms: Date.now() - started,
        upstream_calls: state.upstreamCalls,
        upstream_ms: state.upstreamMs,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(out) }],
        structuredContent: out as Record<string, unknown>,
      };
    } catch (err) {
      const e = toAppError(err);
      log[e.code === "internal" ? "error" : "warn"]("tool.error", {
        tool: name,
        code: e.code,
        ms: Date.now() - started,
        upstream_calls: state.upstreamCalls,
        ...e.logFields,
      });
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: { code: e.code, message: e.message }, diagnostics: diagnostics() }),
          },
        ],
      };
    }
  });
}
