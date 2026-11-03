import { AppError } from "@/core/errors";

/**
 * Date handling in the tenant's timezone (e.g. Asia/Manila). Inputs are calendar dates
 * ("YYYY-MM-DD") interpreted in that zone; outputs are ISO-8601 with the zone offset.
 * Implemented with Intl only (no tz database dependency).
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY = 86_400;

function offsetMs(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(epochMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** Epoch seconds of 00:00 on `date` in `timeZone`. */
export function startOfDay(date: string, timeZone: string): number {
  const m = DATE_RE.exec(date);
  if (!m) throw new AppError("invalid_input", `Invalid date "${date}"; use YYYY-MM-DD.`);
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(guess) || new Date(guess).toISOString().slice(0, 10) !== date) {
    throw new AppError("invalid_input", `Invalid date "${date}".`);
  }
  let ts = guess - offsetMs(guess, timeZone);
  ts = guess - offsetMs(ts, timeZone); // second pass handles DST edges
  return Math.floor(ts / 1000);
}

/** Calendar date ("YYYY-MM-DD") of an instant in `timeZone`. */
export function dateInZone(epochSec: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(epochSec * 1000));
}

/** ISO-8601 local time with offset, e.g. 2026-10-05T14:03:00+08:00. */
export function formatInZone(epochSec: number | null, timeZone: string): string | null {
  if (epochSec === null) return null;
  const ms = epochSec * 1000;
  const off = offsetMs(ms, timeZone);
  const local = new Date(ms + off).toISOString().slice(0, 19);
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off) / 60_000;
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export type WindowSemantics = "accessed_since" | "last_access_in_range";

export interface AccessWindow {
  from: number; // epoch seconds, inclusive
  to: number | null; // epoch seconds, exclusive; null = now
  semantics: WindowSemantics;
  /** Plain-language statement of exactly what the window measures. */
  description: string;
}

export interface WindowInput {
  recent_days?: number | undefined;
  since?: string | undefined;
  until?: string | undefined;
}

/**
 * Resolve a time window.
 *
 * The LMS API exposes only the LAST access time per person/course, so:
 *  - a window ending now ("recent_days", or "since" with no past "until") is EXACT:
 *    last access >= start  <=>  accessed at least once in the window;
 *  - a window ending in the past can only tell whether the LAST access fell inside it.
 *    People who accessed in the window AND again later are not counted. This is labelled
 *    explicitly (semantics = last_access_in_range) so it is never presented as exact.
 */
export function resolveWindow(input: WindowInput, timeZone: string, nowSec: number): AccessWindow | null {
  const { recent_days, since, until } = input;
  if (recent_days === undefined && since === undefined && until === undefined) return null;
  if (recent_days !== undefined && (since !== undefined || until !== undefined)) {
    throw new AppError("invalid_input", "Use either recent_days or since/until, not both.");
  }
  if (recent_days !== undefined) {
    return {
      from: nowSec - recent_days * DAY,
      to: null,
      semantics: "accessed_since",
      description: `Accessed at least once in the last ${recent_days} day(s) (rolling, up to now).`,
    };
  }
  if (since === undefined) throw new AppError("invalid_input", "`until` requires `since`.");
  const from = startOfDay(since, timeZone);
  if (from > nowSec) throw new AppError("invalid_input", "`since` is in the future.");
  const today = dateInZone(nowSec, timeZone);
  if (until === undefined || until >= today) {
    return {
      from,
      to: null,
      semantics: "accessed_since",
      description: `Accessed at least once from ${since} up to now (${timeZone}).`,
    };
  }
  if (until < since) throw new AppError("invalid_input", "`until` is before `since`.");
  const to = startOfDay(until, timeZone) + DAY;
  return {
    from,
    to,
    semantics: "last_access_in_range",
    description:
      `Last access fell between ${since} and ${until} inclusive (${timeZone}). ` +
      "This is NOT 'everyone who accessed in that period': people who also accessed after " +
      `${until} are excluded, because the LMS only records the most recent access.`,
  };
}

export function inWindow(epochSec: number | null, w: AccessWindow): boolean {
  if (epochSec === null) return false;
  return epochSec >= w.from && (w.to === null || epochSec < w.to);
}
