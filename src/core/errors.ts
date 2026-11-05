/**
 * Error model. Every error that can reach a tool result is an AppError with a
 * stable `code` and a message that is safe to show to the LLM and the user:
 * no tokens, URLs with credentials, stack traces or raw upstream payloads.
 */
export type ErrorCode =
  | "not_configured" // a data source this tool needs has no credentials in this deployment
  | "invalid_input" // arguments are syntactically valid but semantically wrong
  | "not_found" // the requested course / person does not exist or is out of scope
  | "scope_too_large" // the request would exceed the time / size budget; narrow it
  | "upstream_unavailable" // network error, timeout or 5xx from the source system
  | "upstream_denied" // source system rejected the call (permissions / token)
  | "upstream_error" // source system returned an application error
  | "upstream_schema" // source system answered in an unexpected shape
  | "internal";

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    /** Extra, non-sensitive diagnostics for logs only (never returned to the client). */
    readonly logFields: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  return new AppError("internal", "Unexpected server error.", {
    error_name: err instanceof Error ? err.name : typeof err,
  });
}

/**
 * True when a tool call should stop and hand back what it finished: the request's time budget
 * ran out (scope_too_large), or the LMS stalled on one call after progress was made
 * (upstream_unavailable). Callers decide what "progress" means.
 */
export function isOutOfTime(err: unknown): boolean {
  return err instanceof AppError && (err.code === "scope_too_large" || err.code === "upstream_unavailable");
}
