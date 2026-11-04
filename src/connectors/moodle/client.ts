import type { z } from "zod";
import { assertWithinBudget } from "@/core/concurrency";
import { AppError } from "@/core/errors";
import { log } from "@/core/logger";
import { requestContext } from "@/core/request-context";

/**
 * Moodle REST web-service client.
 *
 *  - POSTs to /webservice/rest/server.php with the token in the FORM BODY (never the URL),
 *    so it cannot leak through access logs or proxies.
 *  - Moodle reports application errors as HTTP 200 + {exception, errorcode, message};
 *    these are mapped to typed AppErrors. Moodle's message is NOT forwarded (it can echo
 *    parameters); only the errorcode is logged.
 *  - One retry on network errors / timeouts / 5xx. Never on Moodle application errors.
 *  - Every call is bounded by min(timeout, remaining request budget).
 */

export interface MoodleClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

type Params = Record<string, unknown>;

const DENIED_CODES = new Set([
  "invalidtoken",
  "accessexception",
  "nopermissions",
  "requireloginerror",
  "servicerequireslogin",
  "usernotfullysetup",
  "sitemaintenance",
]);

export class MoodleClient {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: MoodleClientOptions) {
    this.endpoint = `${opts.baseUrl}/webservice/rest/server.php`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async call<S extends z.ZodType>(wsfunction: string, params: Params, schema: S): Promise<z.infer<S>> {
    const body = new URLSearchParams();
    body.set("wstoken", this.opts.token);
    body.set("wsfunction", wsfunction);
    body.set("moodlewsrestformat", "json");
    for (const [k, v] of flattenParams(params)) body.append(k, v);

    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const json = await this.post(wsfunction, body);
        return parseResult(wsfunction, json, schema);
      } catch (err) {
        const retryable = err instanceof AppError && err.code === "upstream_unavailable";
        if (!retryable || attempt >= 2) throw err;
        log.warn("moodle.retry", { wsfunction, attempt });
      }
    }
  }

  private async post(wsfunction: string, body: URLSearchParams): Promise<unknown> {
    assertWithinBudget();
    const ctx = requestContext.get();
    const remaining = ctx ? ctx.deadline - Date.now() : this.opts.timeoutMs;
    const timeout = Math.max(1000, Math.min(this.opts.timeoutMs, remaining));
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body,
        signal: AbortSignal.timeout(timeout),
        cache: "no-store",
      });
    } catch (err) {
      throw new AppError("upstream_unavailable", "The LMS did not respond in time. Try again shortly.", {
        wsfunction,
        cause: err instanceof Error ? err.name : "unknown",
      });
    } finally {
      const ms = Date.now() - started;
      if (ctx) {
        ctx.upstreamCalls++;
        ctx.upstreamMs += ms;
      }
      log.debug("moodle.call", { wsfunction, ms });
    }
    if (res.status >= 500) {
      throw new AppError("upstream_unavailable", "The LMS is temporarily unavailable.", {
        wsfunction,
        status: res.status,
      });
    }
    if (!res.ok) {
      throw new AppError("upstream_denied", "The LMS rejected the request.", {
        wsfunction,
        status: res.status,
      });
    }
    try {
      return await res.json();
    } catch (err) {
      // The timeout also covers reading the body: an abort mid-download is a timeout, not bad data.
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new AppError("upstream_unavailable", "The LMS did not respond in time. Try again shortly.", {
          wsfunction,
          cause: err.name,
          phase: "body",
        });
      }
      throw new AppError("upstream_schema", "The LMS returned an unreadable response.", { wsfunction });
    }
  }
}

function parseResult<S extends z.ZodType>(wsfunction: string, json: unknown, schema: S): z.infer<S> {
  if (json && typeof json === "object" && !Array.isArray(json) && "exception" in json) {
    // The errorcode is a fixed Moodle identifier (e.g. "invalidparameter") and safe to surface.
    // Moodle's free-text message and debuginfo are NOT forwarded: they can echo request parameters.
    const errorcode = String((json as Record<string, unknown>).errorcode ?? "unknown");
    if (DENIED_CODES.has(errorcode)) {
      throw new AppError(
        "upstream_denied",
        `The LMS service account is not permitted to read this data (${wsfunction}: ${errorcode}). ` +
          "Check the web-service token, role capabilities and service functions (docs/MOODLE_SETUP.md).",
        { wsfunction, errorcode },
      );
    }
    // Course-context failures wrap a fixed Moodle reason ("User not fully set-up", "Site policy
    // not agreed", "Course or activity not accessible"); surfacing it turns a vague error into
    // an actionable one. Tags/links are stripped and the length is capped.
    const reason = errorcode === "errorcoursecontextnotvalid" ? contextReason(json) : null;
    if (reason) {
      throw new AppError(
        "upstream_denied",
        `The LMS refused course access for the service account (${wsfunction}): ${reason}.` +
          (CONTEXT_HINTS.find(([re]) => re.test(reason))?.[1] ?? ""),
        { wsfunction, errorcode, reason },
      );
    }
    throw new AppError("upstream_error", `The LMS returned an error (${wsfunction}: ${errorcode}).`, {
      wsfunction,
      errorcode,
    });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new AppError("upstream_schema", `The LMS returned data in an unexpected format (${wsfunction}).`, {
      wsfunction,
      issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  return parsed.data;
}

const CONTEXT_HINTS: Array<[RegExp, string]> = [
  [
    /policy/i,
    " Accept the site policy for the service account (Users → Privacy and policies → User agreements).",
  ],
  [/not fully set-?up/i, " Fill the service account's required profile fields."],
  [
    /not accessible|not enrolled/i,
    " Check the service role has moodle/course:view and no category/course override.",
  ],
];

function contextReason(json: unknown): string | null {
  const message = String((json as Record<string, unknown>).message ?? "");
  const m = /context error message was:\s*(.+)$/is.exec(message);
  if (!m) return null;
  const clean = m[1]!
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[\s:.]+$/, "")
    .trim();
  return clean ? clean.slice(0, 120) : null;
}

/**
 * Moodle's REST protocol encodes nested structures PHP-style:
 *   { options: [{ name: "a", value: 1 }] }  ->  options[0][name]=a&options[0][value]=1
 */
export function flattenParams(params: Params, prefix = ""): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(params)) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item !== null && typeof item === "object")
          out.push(...flattenParams(item as Params, `${name}[${i}]`));
        else out.push([`${name}[${i}]`, scalar(item)]);
      });
    } else if (typeof value === "object") {
      out.push(...flattenParams(value as Params, name));
    } else {
      out.push([name, scalar(value)]);
    }
  }
  return out;
}

function scalar(v: unknown): string {
  if (typeof v === "boolean") return v ? "1" : "0";
  return String(v);
}
