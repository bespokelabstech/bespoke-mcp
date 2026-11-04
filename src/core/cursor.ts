import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "./errors";

/**
 * Stateless continuation for answers delivered in parts. The cursor carries everything
 * the next call needs (which courses are done, running totals) so the server stores
 * nothing. It is HMAC-signed with a key derived from the access key and bound to the
 * exact query, so it cannot be edited or replayed against a different question.
 */

export interface CursorPayload {
  v: 1;
  /** Hash of the query arguments (excluding cursor/limit). */
  q: string;
  /** Course ids already processed. */
  done: number[];
  /** Opaque, query-specific running state. */
  state: unknown;
}

export const MAX_CURSOR_BYTES = 9_000;

export function queryHash(args: Record<string, unknown>): string {
  const { cursor: _c, limit: _l, ...rest } = args;
  return createHash("sha256").update(stableStringify(rest)).digest("base64url").slice(0, 22);
}

/** True if this payload still fits a cursor (check early, before doing more work). */
export function cursorFits(payload: CursorPayload): boolean {
  return Math.ceil((Buffer.byteLength(JSON.stringify(payload)) * 4) / 3) <= MAX_CURSOR_BYTES * 0.9;
}

export function encodeCursor(payload: CursorPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  if (body.length > MAX_CURSOR_BYTES) {
    throw new AppError(
      "scope_too_large",
      "This breakdown has too many groups to answer in parts. Group by course, or add a filter.",
    );
  }
  return `${body}.${sign(body, secret)}`;
}

export function decodeCursor(cursor: string, secret: string, expectedQuery: string): CursorPayload {
  const [body, mac] = cursor.split(".");
  if (!body || !mac || !safeEqual(mac, sign(body, secret))) {
    throw new AppError("invalid_input", "Invalid cursor. Start the query again without a cursor.");
  }
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CursorPayload;
  if (payload.v !== 1 || payload.q !== expectedQuery) {
    throw new AppError(
      "invalid_input",
      "This cursor belongs to a different query. Repeat the original arguments exactly, plus the cursor.",
    );
  }
  return payload;
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url").slice(0, 32);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}
