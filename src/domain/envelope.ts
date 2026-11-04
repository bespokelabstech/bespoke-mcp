import type { TenantConfig } from "@/tenants/schema";
import type { AccessWindow } from "./time";
import { formatInZone } from "./time";

/** Bump when any metric definition in docs/METRICS.md changes meaning. */
export const DEFINITIONS_VERSION = "2026-11-mvp3";

export interface Envelope<T> {
  tenant: string;
  environment: string;
  source: string;
  as_of: string;
  timezone: string;
  definitions_version: string;
  vocabulary: { person: string; course: string };
  scope?: { course_count: number; courses?: Array<{ id: number; name: string }> } | undefined;
  filters?: Record<string, unknown> | undefined;
  window?: (Omit<AccessWindow, "from" | "to"> & { from: string | null; to: string | null }) | undefined;
  warnings: string[];
  data: T;
}

export function buildEnvelope<T>(args: {
  tenant: TenantConfig;
  environment: string;
  source: string;
  nowSec: number;
  data: T;
  courses?: Array<{ id: number; fullName: string }>;
  filters?: Record<string, unknown>;
  window?: AccessWindow | null;
  warnings?: string[];
}): Envelope<T> {
  const tz = args.tenant.timezone;
  return {
    tenant: args.tenant.id,
    environment: args.environment,
    source: args.source,
    as_of: formatInZone(args.nowSec, tz)!,
    timezone: tz,
    definitions_version: DEFINITIONS_VERSION,
    vocabulary: { person: args.tenant.vocabulary.person, course: args.tenant.vocabulary.course },
    scope: args.courses
      ? {
          course_count: args.courses.length,
          // Name the courses when the list is short enough to be useful in an answer.
          courses:
            args.courses.length <= 25 ? args.courses.map((c) => ({ id: c.id, name: c.fullName })) : undefined,
        }
      : undefined,
    filters: args.filters && Object.keys(args.filters).length ? args.filters : undefined,
    window: args.window
      ? {
          semantics: args.window.semantics,
          description: args.window.description,
          from: formatInZone(args.window.from, tz),
          to: formatInZone(args.window.to, tz),
        }
      : undefined,
    warnings: args.warnings ?? [],
    data: args.data,
  };
}
