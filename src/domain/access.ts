import { mapLimit } from "@/core/concurrency";
import type { Course, LearningDataPort, Participant, PersonCourse } from "@/ports/learning";
import type { DimensionId, TenantConfig } from "@/tenants/schema";
import type { Filters, PersonView } from "./people";
import { dimensionValue, matchesFilters, participantIneligibility, toPersonView } from "./people";
import type { AccessWindow } from "./time";
import { inWindow } from "./time";

/**
 * Deterministic access & completion metrics (definitions: docs/METRICS.md).
 * Pure functions over port data — no LLM inference, no hidden estimation.
 */

export type GroupDim = DimensionId | "course";
export type CountBy = "people" | "enrolments";

/** One eligible person's active enrolment in one in-scope course. */
export interface EnrolmentRecord {
  person: PersonView;
  course: Course;
  lastCourseAccess: number | null;
}

export interface ScopeData {
  records: EnrolmentRecord[];
  /** Users dropped by the eligibility rule, by reason (for transparency). */
  excluded: Record<string, number>;
}

/** Pull participants for every course (bounded concurrency) and apply eligibility + filters. */
export async function loadScope(
  port: LearningDataPort,
  tenant: TenantConfig,
  courses: Course[],
  filters: Filters,
): Promise<ScopeData> {
  const perCourse = await mapLimit(courses, tenant.limits.upstreamConcurrency, (c) =>
    port.listCourseParticipants(c.id),
  );
  const people = new Map<number, PersonView>();
  const excluded: Record<string, number> = {};
  const excludedUsers = new Set<string>();
  const records: EnrolmentRecord[] = [];
  courses.forEach((course, i) => {
    for (const p of perCourse[i] as Participant[]) {
      const reason = participantIneligibility(p, tenant);
      if (reason) {
        const key = `${reason}:${p.userId}`;
        if (!excludedUsers.has(key)) {
          excludedUsers.add(key);
          excluded[reason] = (excluded[reason] ?? 0) + 1;
        }
        continue;
      }
      let view = people.get(p.userId);
      if (!view) {
        view = toPersonView(p, tenant);
        people.set(p.userId, view);
      }
      if (!matchesFilters(view, filters, tenant.emptyValueLabel)) continue;
      records.push({ person: view, course, lastCourseAccess: p.lastCourseAccess });
    }
  });
  return { records, excluded };
}

/** Per-person course progress, fetched only when explicitly requested and within limits. */
export async function loadCompletion(
  port: LearningDataPort,
  tenant: TenantConfig,
  userIds: number[],
): Promise<Map<number, Map<number, PersonCourse>>> {
  const rows = await mapLimit(userIds, tenant.limits.upstreamConcurrency, (id) => port.listPersonCourses(id));
  const out = new Map<number, Map<number, PersonCourse>>();
  userIds.forEach((id, i) => out.set(id, new Map((rows[i] ?? []).map((c) => [c.courseId, c]))));
  return out;
}

export interface GroupKey {
  region?: string;
  level?: string;
  branch?: string;
  course?: { id: number; name: string };
}

export interface AccessRow {
  group: GroupKey;
  enrolled: number;
  accessed: number;
  never_accessed: number;
  access_rate_pct: number | null;
  accessed_in_window?: number;
  window_rate_pct?: number | null;
  completion?: CompletionStats;
}

export interface CompletionStats {
  basis: "enrolments";
  tracked_enrolments: number;
  completed: number;
  completion_rate_pct: number | null;
  avg_progress_pct: number | null;
}

export interface SummaryOptions {
  groupBy: GroupDim[];
  countBy: CountBy;
  window: AccessWindow | null;
  completion: Map<number, Map<number, PersonCourse>> | null;
}

export function pct(n: number, d: number): number | null {
  return d === 0 ? null : Math.round((n / d) * 1000) / 10;
}

/**
 * Aggregate enrolment records into rows.
 *
 * Unit of counting:
 *  - "enrolments": each (person, course) pair counts once; accessed = last course access exists.
 *  - "people": each person counts once per group; accessed = accessed ANY in-scope course;
 *    window uses the person's most recent access across in-scope courses.
 *  Grouping by course always counts per (person, course), so the two units coincide there.
 * Completion is always enrolment-based (completed enrolments / tracked enrolments).
 */
export function summarize(records: EnrolmentRecord[], opts: SummaryOptions): AccessRow[] {
  const byCourse = opts.groupBy.includes("course");
  const unit: CountBy = byCourse ? "enrolments" : opts.countBy;

  interface Acc {
    group: GroupKey;
    units: Map<string, { last: number | null }>;
    tracked: number;
    completed: number;
    progressSum: number;
    progressN: number;
  }
  const groups = new Map<string, Acc>();

  for (const r of records) {
    const group: GroupKey = {};
    for (const dim of opts.groupBy) {
      if (dim === "course") group.course = { id: r.course.id, name: r.course.fullName };
      else group[dim] = dimensionValue(r.person, dim);
    }
    const key = JSON.stringify(group);
    let acc = groups.get(key);
    if (!acc) {
      acc = { group, units: new Map(), tracked: 0, completed: 0, progressSum: 0, progressN: 0 };
      groups.set(key, acc);
    }
    const unitKey = unit === "enrolments" ? `${r.person.userId}:${r.course.id}` : String(r.person.userId);
    const prev = acc.units.get(unitKey);
    const last = maxNullable(prev?.last ?? null, r.lastCourseAccess);
    acc.units.set(unitKey, { last });

    if (opts.completion) {
      const pc = opts.completion.get(r.person.userId)?.get(r.course.id);
      if (pc && pc.completionEnabled && pc.completed !== null) {
        acc.tracked++;
        if (pc.completed) acc.completed++;
        if (pc.progressPct !== null) {
          acc.progressSum += pc.progressPct;
          acc.progressN++;
        }
      }
    }
  }

  const rows: AccessRow[] = [];
  for (const acc of groups.values()) {
    const units = [...acc.units.values()];
    const enrolled = units.length;
    const accessed = units.filter((u) => u.last !== null).length;
    const row: AccessRow = {
      group: acc.group,
      enrolled,
      accessed,
      never_accessed: enrolled - accessed,
      access_rate_pct: pct(accessed, enrolled),
    };
    if (opts.window) {
      const w = opts.window;
      const n = units.filter((u) => inWindow(u.last, w)).length;
      row.accessed_in_window = n;
      row.window_rate_pct = pct(n, enrolled);
    }
    if (opts.completion) {
      row.completion = {
        basis: "enrolments",
        tracked_enrolments: acc.tracked,
        completed: acc.completed,
        completion_rate_pct: pct(acc.completed, acc.tracked),
        avg_progress_pct: acc.progressN ? Math.round((acc.progressSum / acc.progressN) * 10) / 10 : null,
      };
    }
    rows.push(row);
  }
  rows.sort(
    (a, b) => b.enrolled - a.enrolled || JSON.stringify(a.group).localeCompare(JSON.stringify(b.group)),
  );
  return rows;
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

export function distinctPeople(records: EnrolmentRecord[]): number[] {
  return [...new Set(records.map((r) => r.person.userId))];
}
