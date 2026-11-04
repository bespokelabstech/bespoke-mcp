import type { PersonCourse } from "@/ports/learning";
import type { DimensionId } from "@/tenants/schema";
import { dimensionValue } from "./people";
import type { EnrolmentRecord } from "./population";
import { enrolmentKey } from "./population";
import type { SignalId } from "./signals";
import type { AccessWindow } from "./time";
import { inWindow } from "./time";

/**
 * Deterministic metric aggregation (definitions: docs/METRICS.md). Pure functions over
 * port data — no LLM inference, no estimation.
 *
 * Aggregation is two-step so large questions can be answered in parts without storing
 * anything: `aggregate` produces additive PartialRows (raw counts and sums), `mergePartials`
 * adds partials from different courses, `finalize` turns them into rates.
 */

export type GroupDim = DimensionId | "course";
export type Unit = "people" | "enrolments";

export interface GroupKey {
  region?: string;
  level?: string;
  branch?: string;
  course?: { id: number; name: string };
}

/** Additive counts for one group. Rates are computed only in `finalize`. */
export interface PartialRow {
  group: GroupKey;
  enrolled: number;
  site_ever: number;
  site_window: number;
  web_ever: number;
  web_window: number;
  started: number;
  started_known: number;
  tracked: number;
  completed: number;
  progress_sum: number;
  progress_n: number;
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
}

const empty = (group: GroupKey): PartialRow => ({
  group,
  enrolled: 0,
  site_ever: 0,
  site_window: 0,
  web_ever: 0,
  web_window: 0,
  started: 0,
  started_known: 0,
  tracked: 0,
  completed: 0,
  progress_sum: 0,
  progress_n: 0,
  score_sum: 0,
  score_n: 0,
});

/**
 * Unit of counting:
 *  - "enrolments": each account × course enrolment, as Moodle records it. Additive across
 *    courses and pages, so it can be answered in parts with results identical to one pass.
 *  - "people": each person once per group — duplicate accounts with the same identifier merge;
 *    access = most recent across in-scope courses and accounts, started = started ANY course.
 * Grouping by course always counts enrolments.
 * Completion and score are always enrolment-based.
 */
export function aggregate(records: EnrolmentRecord[], opts: AggregateInput): PartialRow[] {
  const unit: Unit = opts.groupBy.includes("course") ? "enrolments" : opts.unit;
  interface UnitState {
    site: number | null;
    web: number | null;
    started: boolean | null;
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
      else group[dim] = dimensionValue(r.person, dim);
    }
    const gk = JSON.stringify(group);
    let g = groups.get(gk);
    if (!g) {
      g = { group, units: new Map(), enrols: new Map() };
      groups.set(gk, g);
    }
    const enrolKey = unit === "people" ? `${r.person.key}:${r.course.id}` : enrolmentKey(r);
    const pc = opts.personCourses?.get(r.person.userId)?.get(r.course.id) ?? null;
    const started = opts.personCourses
      ? pc
        ? pc.completed === true || (pc.progressPct ?? 0) > 0
        : null
      : null;

    const unitKey = unit === "enrolments" ? enrolKey : r.person.key;
    const prev = g.units.get(unitKey);
    g.units.set(unitKey, {
      site: maxNullable(prev?.site ?? null, r.lastSiteAccess),
      web: maxNullable(prev?.web ?? null, r.lastCourseAccess),
      started: orNullable(prev?.started ?? null, started),
    });

    const e = g.enrols.get(enrolKey) ?? { pc: null, scores: [] };
    if (pc && (!e.pc || pc.completed)) e.pc = pc; // duplicate accounts: keep the furthest along
    const s = opts.scores?.get(r.course.id)?.get(r.person.userId);
    if (s && s.length && e.scores.length === 0) e.scores = s;
    g.enrols.set(enrolKey, e);
  }

  const w = opts.window;
  return [...groups.values()].map((g) => {
    const row = empty(g.group);
    for (const u of g.units.values()) {
      row.enrolled++;
      if (u.site !== null) row.site_ever++;
      if (u.web !== null) row.web_ever++;
      if (w && inWindow(u.site, w)) row.site_window++;
      if (w && inWindow(u.web, w)) row.web_window++;
      if (u.started !== null) {
        row.started_known++;
        if (u.started) row.started++;
      }
    }
    for (const e of g.enrols.values()) {
      if (e.pc && e.pc.completionEnabled && e.pc.completed !== null) {
        row.tracked++;
        if (e.pc.completed) row.completed++;
        if (e.pc.progressPct !== null) {
          row.progress_sum += e.pc.progressPct;
          row.progress_n++;
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

const NUMERIC_FIELDS = [
  "enrolled",
  "site_ever",
  "site_window",
  "web_ever",
  "web_window",
  "started",
  "started_known",
  "tracked",
  "completed",
  "progress_sum",
  "progress_n",
  "score_sum",
  "score_n",
] as const satisfies ReadonlyArray<keyof PartialRow>;

export function pct(n: number, d: number): number | null {
  return d === 0 ? null : Math.round((n / d) * 1000) / 10;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

export interface MetricRow {
  group?: GroupKey;
  enrolled: number;
  started?: { count: number; rate_pct: number | null; unknown: number };
  completion?: {
    basis: "enrolments";
    tracked_enrolments: number;
    completed: number;
    completion_rate_pct: number | null;
    avg_progress_pct: number | null;
  };
  site_last_access?: { ever: number; in_window?: number; window_rate_pct?: number | null };
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
      case "started":
        out.started = {
          count: row.started,
          rate_pct: pct(row.started, row.started_known),
          unknown: row.enrolled - row.started_known,
        };
        break;
      case "completion":
        out.completion = {
          basis: "enrolments",
          tracked_enrolments: row.tracked,
          completed: row.completed,
          completion_rate_pct: pct(row.completed, row.tracked),
          avg_progress_pct: row.progress_n ? round1(row.progress_sum / row.progress_n) : null,
        };
        break;
      case "site_last_access":
        out.site_last_access = windowed
          ? {
              ever: row.site_ever,
              in_window: row.site_window,
              window_rate_pct: pct(row.site_window, row.enrolled),
            }
          : { ever: row.site_ever };
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

/** Largest groups first, ties by group label. */
export function sortRows(rows: PartialRow[]): PartialRow[] {
  return [...rows].sort(
    (a, b) => b.enrolled - a.enrolled || JSON.stringify(a.group).localeCompare(JSON.stringify(b.group)),
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
