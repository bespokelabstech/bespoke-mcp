/**
 * Minimal structured logger: one JSON object per line on stdout/stderr, which
 * Vercel's log viewer and log drains index as-is.
 *
 * Rules (see docs/ARCHITECTURE.md#logging):
 *  - never log secrets, request headers, Moodle response bodies or personal data;
 *  - log identifiers of *what* happened (tool, error code, counts, timings), not the data.
 */
import { requestContext } from "./request-context";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
  return ORDER[raw] ?? ORDER.info;
}

// Field names whose values are always dropped (exact sensitive names, not substrings,
// so diagnostic fields like `arg_keys` survive).
const REDACT = /(^|[_-])(w?s?token|secret|password|authorization|cookie|api_?key|access_?key)$/i;

function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = REDACT.test(k) ? "[redacted]" : v;
  }
  return out;
}

function emit(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < threshold()) return;
  const ctx = requestContext.get();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    tenant: process.env.MCP_TENANT,
    env: process.env.MCP_ENV,
    request_id: ctx?.requestId,
    ...sanitize(fields),
  });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};
