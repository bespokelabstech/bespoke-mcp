import type { PersonCourse } from "@/ports/learning";
import type { DimensionId } from "@/tenants/schema";
import { dimensionValue } from "./people";
import type { EnrolmentRecord } from "./population";
import { enrolmentKey } from "./population";
import type { SignalId } from "./signals";
import type { AccessWindow } from "./time";
import { inWindow } from "./time";

/**
 * Deterministic metric aggregation (definitions: docs/METRICS.md, labels: BES-465 glossary).
 * Pure functions over port data — no LLM inference, no estimation.
 *
 * Aggregation is two-step so large questions can be answered in parts without storing
 * anything: `aggregate` produces additive PartialRows (raw counts and sums), `mergePartials`
 * adds partials from different courses, `finalize` turns them into rates.
 */

export type GroupDim = DimensionId | "course" | "category";
export type Unit = "accounts" | "enrolments";

export interface GroupKey {
  region?: string;
  level?: string;
  branch?: string;
  course?: { id: number; name: string };
  category?: { id: number; name: string | null };
}

/** Additive counts for one group. Rates are computed only in `finalize`. */
export interface PartialRow {
  group: GroupKey;
  /** Units (accounts or enrolments) in the group. */
  enrolled: number;
  /** Enrolments in the group (the denominator of avg. completion). */
  enrolments: number;
  login_ever: number;
  login_window: number;
  web_ever: number;
  web_window: number;
  accessed: number;
  accessed_known: number;
  /** Units with accessed known AND a sign-in on record (access-rate denominator). */
  login_known: number;
  completed: number;
  progress_sum: number;
  progress_n: number;
  untracked: number;
  score_sum: number;
  score_n: number;
}

export interface AggregateInput {
  groupBy: GroupDim[];
  unit: Unit;
  window: AccessWindow | null;
  /** userId -> courseId -> progress, when per-person signals were fetched. */
  personCourses: Map<number, Map<number, PersonCourse>> | null;
  /** courseId -> userId -> quiz percentages, when avg_score was fetched. */
  scores: Map<number, Map<number, number[]>> | null;
  /** categoryId -> name, for group_by category. */
  categoryNames?: Map<number, string> | undefined;
}

export const NUMERIC_FIELDS = [
  "enrolled",
  "enrolments",
  "login_ever",
  "login_window",
  "web_ever",
  "web_window",
  "accessed",
  "accessed_known",
  "login_known",
  "completed",
  "progress_sum",
  "progress_n",
  "untracked",
  "score_sum",
  "score_n",
] as const satisfies ReadonlyArray<keyof PartialRow>;

const empty = (group: GroupKey): PartialRow => {
  const row = { group } as PartialRow;
  for (const f of NUMERIC_FIELDS) row[f] = 0;
  return row;
};

/**
 * Unit of counting (each account counts on its own; accounts are never merged):
 *  - "accounts": each account once per group — last sign-in is per account, accessed = accessed
 *    ANY in-scope course in the group.
 *  - "enrolments": each account × course enrolment. Additive across courses and pages, so it
 *    can be answered in parts with results identical to one pass.
 * Grouping by course always counts enrolments. Progress and score are always enrolment-based.
 */
export function aggregate(records: EnrolmentRecord[], opts: AggregateInput): PartialRow[] {
  const unit: Unit = opts.groupBy.includes("course") ? "enrolments" : opts.unit;
  interface UnitState {
    site: number | null;
    web: number | null;
    accessed: boolean | null;
  }
  interface EnrolState {
    pc: PersonCourse | null;
    scores: number[];
  }
  const groups = new Map<
    string,
    { group: GroupKey; units: Map<string, UnitState>; enrols: Map<string, EnrolState> }
  >();

  for (const r of records) {
    const group: GroupKey = {};
    for (const dim of opts.groupBy) {
      if (dim === "course") group.course = { id: r.course.id, name: r.course.fullName };
      else if (dim === "category") {
        group.category = {
          id: r.course.categoryId,
          name: opts.categoryNames?.get(r.course.categoryId) ?? null,
        };
      } else group[dim] = dimensionValue(r.person, dim);
    }
    const gk = JSON.stringify(group);
    let g = groups.get(gk);
    if (!g) {
      g = { group, units: new Map(), enrols: new Map() };
      groups.set(gk, g);
    }
    const enrolKey = enrolmentKey(r);
    const pc = opts.personCourses?.get(r.person.userId)?.get(r.course.id) ?? null;
    const accessed = opts.personCourses ? (pc ? isAccessed(pc) : null) : null;

    const unitKey = unit === "enrolments" ? enrolKey : `u:${r.person.userId}`;
    const prev = g.units.get(unitKey);
    g.units.set(unitKey, {
      site: maxNullable(prev?.site ?? null, r.lastSiteAccess),
      web: maxNullable(prev?.web ?? null, r.lastCourseAccess),
      accessed: orNullable(prev?.accessed ?? null, accessed),
    });

    const s = opts.scores?.get(r.course.id)?.get(r.person.userId);
    g.enrols.set(enrolKey, { pc, scores: s ?? [] });
  }

  const w = opts.window;
  const withProgress = opts.personCourses !== null;
  return [...groups.values()].map((g) => {
    const row = empty(g.group);
    for (const u of g.units.values()) {
      row.enrolled++;
      if (u.site !== null) row.login_ever++;
      if (u.web !== null) row.web_ever++;
      if (w && inWindow(u.site, w)) row.login_window++;
      if (w && inWindow(u.web, w)) row.web_window++;
      if (u.accessed !== null) {
        row.accessed_known++;
        if (u.accessed) row.accessed++;
        if (u.site !== null) row.login_known++;
      }
    }
    for (const e of g.enrols.values()) {
      row.enrolments++;
      if (withProgress) {
        if (e.pc && e.pc.completionEnabled && e.pc.completed !== null) {
          if (e.pc.completed) row.completed++;
          if (e.pc.progressPct !== null) {
            row.progress_sum += e.pc.progressPct;
            row.progress_n++;
          }
        } else {
          row.untracked++;
        }
      }
      for (const v of e.scores) {
        row.score_sum += v;
        row.score_n++;
      }
    }
    return row;
  });
}

/** Accessed = completed at least one activity (progress > 0%) or completed the course. */
export function isAccessed(pc: PersonCourse): boolean {
  return pc.completed === true || (pc.progressPct ?? 0) > 0;
}

/** Add partials (from disjoint course sets) group by group. */
export function mergePartials(a: PartialRow[], b: PartialRow[]): PartialRow[] {
  const out = new Map(a.map((r) => [JSON.stringify(r.group), { ...r }]));
  for (const r of b) {
    const k = JSON.stringify(r.group);
    const t = out.get(k);
    if (!t) {
      out.set(k, { ...r });
      continue;
    }
    for (const f of NUMERIC_FIELDS) t[f] += r[f];
  }
  return [...out.values()];
}

export function pct(n: number, d: number): number | null {
  return d === 0 ? null : Math.round((n / d) * 1000) / 10;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

export interface MetricRow {
  group?: GroupKey;
  enrolled: number;
  logged_in?: { count: number; pct_of_enrolled: number | null; ever?: number };
  accessed?: { count: number; access_rate_pct: number | null; unknown: number };
  progress?: {
    basis: "enrolments";
    enrolments: number;
    completed: number;
    avg_completion_pct: number | null;
    avg_progress_pct: number | null;
    untracked_enrolments: number;
  };
  web_course_access?: { ever: number; in_window?: number; window_rate_pct?: number | null };
  avg_score?: { graded_items: number; avg_score_pct: number | null };
}

export function finalize(
  row: PartialRow,
  signals: readonly SignalId[],
  windowed: boolean,
  withGroup = true,
): MetricRow {
  const out: MetricRow = withGroup
    ? { group: row.group, enrolled: row.enrolled }
    : { enrolled: row.enrolled };
  for (const s of signals) {
    switch (s) {
      case "logged_in": {
        const count = windowed ? row.login_window : row.login_ever;
        out.logged_in = {
          count,
          pct_of_enrolled: pct(count, row.enrolled),
          ...(windowed ? { ever: row.login_ever } : {}),
        };
        break;
      }
      case "accessed":
        out.accessed = {
          count: row.accessed,
          // Accessed is all-time; dividing it by a windowed "logged in" would be meaningless.
          access_rate_pct: windowed ? null : pct(row.accessed, row.login_known),
          unknown: row.enrolled - row.accessed_known,
        };
        break;
      case "progress":
        out.progress = {
          basis: "enrolments",
          enrolments: row.enrolments,
          completed: row.completed,
          avg_completion_pct: pct(row.completed, row.enrolments),
          avg_progress_pct: row.progress_n ? round1(row.progress_sum / row.progress_n) : null,
          untracked_enrolments: row.untracked,
        };
        break;
      case "web_course_access":
        out.web_course_access = windowed
          ? {
              ever: row.web_ever,
              in_window: row.web_window,
              window_rate_pct: pct(row.web_window, row.enrolled),
            }
          : { ever: row.web_ever };
        break;
      case "avg_score":
        out.avg_score = {
          graded_items: row.score_n,
          avg_score_pct: row.score_n ? round1(row.score_sum / row.score_n) : null,
        };
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- sorting

/** Sortable columns of query_metrics rows, and the signal each one needs. */
export const METRIC_SORT_KEYS = {
  enrolled: null,
  group: null,
  logged_in: "logged_in",
  logged_in_pct: "logged_in",
  accessed: "accessed",
  access_rate: "accessed",
  avg_progress: "progress",
  completed: "progress",
  avg_completion: "progress",
  web_course_access: "web_course_access",
  avg_score: "avg_score",
} as const satisfies Record<string, SignalId | null>;
export type MetricSortKey = keyof typeof METRIC_SORT_KEYS;

export function groupLabel(g: GroupKey | undefined): string {
  if (!g) return "";
  return [g.region, g.level, g.branch, g.course?.name, g.category?.name ?? g.category?.id]
    .filter((x) => x !== undefined)
    .join(" / ");
}

function metricValue(r: MetricRow, key: MetricSortKey): number | string | null {
  switch (key) {
    case "enrolled":
      return r.enrolled;
    case "group":
      return groupLabel(r.group);
    case "logged_in":
      return r.logged_in?.count ?? null;
    case "logged_in_pct":
      return r.logged_in?.pct_of_enrolled ?? null;
    case "accessed":
      return r.accessed?.count ?? null;
    case "access_rate":
      return r.accessed?.access_rate_pct ?? null;
    case "avg_progress":
      return r.progress?.avg_progress_pct ?? null;
    case "completed":
      return r.progress?.completed ?? null;
    case "avg_completion":
      return r.progress?.avg_completion_pct ?? null;
    case "web_course_access":
      return r.web_course_access ? (r.web_course_access.in_window ?? r.web_course_access.ever) : null;
    case "avg_score":
      return r.avg_score?.avg_score_pct ?? null;
  }
}

/** Parse "-col" (descending) or "col" (ascending). */
export function parseSort<K extends string>(spec: string): { key: K; desc: boolean } {
  return spec.startsWith("-") ? { key: spec.slice(1) as K, desc: true } : { key: spec as K, desc: false };
}

/** Compare two values; nulls always last, whatever the direction. */
export function compareValues(a: number | string | null, b: number | string | null, desc: boolean): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const c = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
  return desc ? -c : c;
}

/** Sort final rows on any column; ties by group label. */
export function sortMetricRows(rows: MetricRow[], spec: string): MetricRow[] {
  const { key, desc } = parseSort<MetricSortKey>(spec);
  return [...rows].sort(
    (a, b) =>
      compareValues(metricValue(a, key), metricValue(b, key), desc) ||
      groupLabel(a.group).localeCompare(groupLabel(b.group)),
  );
}

/** A single totals partial for a set of records (no grouping). */
export function totals(records: EnrolmentRecord[], opts: Omit<AggregateInput, "groupBy">): PartialRow {
  return aggregate(records, { ...opts, groupBy: [] })[0] ?? empty({});
}

export function emptyPartial(): PartialRow {
  return empty({});
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function orNullable(a: boolean | null, b: boolean | null): boolean | null {
  if (a === null) return b;
  if (b === null) return a;
  return a || b;
}
