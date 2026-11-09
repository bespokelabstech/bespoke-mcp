import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { assertWithinBudget } from "@/core/concurrency";
import type { CursorPayload } from "@/core/cursor";
import { cursorFits, decodeCursor, encodeCursor, queryHash } from "@/core/cursor";
import { AppError, isOutOfTime } from "@/core/errors";
import { loadPersonCourses, loadScores } from "@/domain/enrich";
import { buildEnvelope } from "@/domain/envelope";
import type { AggregateInput, GroupDim, GroupKey, MetricSortKey, PartialRow, Unit } from "@/domain/metrics";
import {
  aggregate,
  emptyPartial,
  finalize,
  METRIC_SORT_KEYS,
  mergePartials,
  NUMERIC_FIELDS,
  parseSort,
  sortMetricRows,
} from "@/domain/metrics";
import type { Filters } from "@/domain/people";
import { familyNotes } from "@/domain/people";
import type { EnrolmentRecord, PopulationCounts } from "@/domain/population";
import {
  addCounts,
  emptyCounts,
  loadScope,
  loadScopePage,
  populationCounts,
  selectPopulation,
} from "@/domain/population";
import { resolveCourseScope } from "@/domain/scope";
import type { SignalId } from "@/domain/signals";
import { DEFAULT_SIGNALS, PER_PERSON_SIGNALS, SIGNALS } from "@/domain/signals";
import type { AccessWindow } from "@/domain/time";
import { resolveWindow } from "@/domain/time";
import type { Course, LearningDataPort } from "@/ports/learning";
import type { TenantConfig } from "@/tenants/schema";
import { dataWarnings, regionSourceNote } from "./notes";
import type { ToolDeps } from "./runtime";
import { READ_ONLY_ANNOTATIONS, remainingBudgetMs, requireLearning, runTool } from "./runtime";
import {
  excludeField,
  filtersField,
  populationOut,
  resolveFilters,
  scopeFields,
  signalsField,
  validOnlyField,
  windowFields,
} from "./shared-schemas";

const SORT_VALUES = Object.keys(METRIC_SORT_KEYS).flatMap((k) => [k, `-${k}`]) as [string, ...string[]];

/**
 * Three ways to answer, chosen automatically:
 *  - single: enrolment-level or people-level without per-person signals, fits one call.
 *  - pages:  enrolment-level, no per-person signals — work unit = one page of one course, so
 *            even very large courses split across calls. Results are additive.
 *  - people: per-person signals (accessed, progress) — work unit = a batch of accounts (one LMS
 *            call each covers all their courses). Finishes in one call when the scope is small.
 * Parts continue via a signed cursor carrying position and compact running sums; nothing is stored.
 */

/** A PartialRow packed for the cursor: [group values in group_by order (course → id), ...numeric fields]. */
type Packed = [Array<string | number>, ...number[]];
type PagesState = {
  m: "pages";
  cid: number | null;
  off: number;
  acc: Packed[];
  tot: Packed;
  pop: PopulationCounts;
  obs: string[];
};
type PeopleState = { m: "people"; after: string | null; acc: Packed[]; tot: Packed };

export function registerQueryMetrics(server: McpServer, deps: ToolDeps): void {
  const t = deps.tenant;
  const v = t.vocabulary;
  const people = v.personPlural.toLowerCase();
  const inputSchema = z.strictObject({
    ...scopeFields(t),
    filters: filtersField(t),
    exclude: excludeField(t),
    valid_only: validOnlyField(t),
    group_by: z
      .array(z.enum(["region", "level", "branch", "course", "category"]))
      .max(2)
      .default([])
      .describe("Zero, one or two dimensions to group by. Empty = totals only."),
    count_by: z
      .enum(["accounts", "enrolments"])
      .default("accounts")
      .describe(
        `accounts = each account once per group (every account counts on its own); ` +
          `enrolments = each account-${v.course.toLowerCase()} enrolment. Grouping by ${v.course.toLowerCase()} always counts enrolments.`,
      ),
    signals: signalsField,
    ...windowFields(t),
    sort: z
      .enum(SORT_VALUES)
      .default("-enrolled")
      .describe(
        "Sort rows on any column; prefix '-' for descending. Default -enrolled (largest first). " +
          "Columns other than enrolled/group need their metric in signals.",
      ),
    limit: z.number().int().min(1).max(500).default(50).describe("Max rows returned (after sorting)."),
    cursor: z
      .string()
      .max(12_000)
      .optional()
      .describe("Continuation from a previous partial answer. Repeat the SAME arguments plus this cursor."),
  });

  server.registerTool(
    "query_metrics",
    {
      title: `${v.person} engagement metrics`,
      description:
        `Count ${people} and their metrics (Enrolled, Logged in, Accessed, Access rate, Progress, Completed, Avg. completion, ` +
        `web course access, average score), grouped by ${t.dimensions.region.label}, ${t.dimensions.level.label}, ` +
        `${t.dimensions.branch.label}, ${v.course} and/or category. Defaults: valid dealers only, the default exclude lists ` +
        `(see describe_capabilities), largest groups first. Large questions are answered in parts: while complete=false, ` +
        `call again with the same arguments plus next_cursor; rows and totals come with the last part. ` +
        `Report numbers exactly as returned; never recompute or estimate.`,
      inputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) =>
      runTool("query_metrics", deps, args, async () => {
        const port = requireLearning(deps);
        const now = deps.nowSec();
        const window = resolveWindow(args, t.timezone, now);
        const groupBy = args.group_by as GroupDim[];
        const unit: Unit = groupBy.includes("course") ? "enrolments" : args.count_by;
        const resolved = resolveFilters(args, t);
        const courses = await resolveCourseScope(port, t, args);
        const warnings: string[] = [];
        const skipped: Array<{ signal: SignalId; reason: string }> = [];

        let signals: SignalId[] = [...new Set(args.signals ?? DEFAULT_SIGNALS)];
        const sortSignal = METRIC_SORT_KEYS[parseSort<MetricSortKey>(args.sort).key];
        if (sortSignal && !signals.includes(sortSignal)) {
          throw new AppError("invalid_input", `sort "${args.sort}" needs "${sortSignal}" in signals.`);
        }
        const wantsPerPerson = signals.some((s) => PER_PERSON_SIGNALS.includes(s));
        if (signals.includes("avg_score") && !(await port.capabilities()).grades) {
          signals = signals.filter((s) => s !== "avg_score");
          skipped.push({
            signal: "avg_score",
            reason: "The LMS service does not include the grade report function.",
          });
        } else if (signals.includes("avg_score") && wantsPerPerson) {
          // Grade reports are per course (all users at once); repeating them in every
          // account batch would consume the time budget. avg_score is enrolment-based anyway.
          signals = signals.filter((s) => s !== "avg_score");
          skipped.push({
            signal: "avg_score",
            reason: "Ask for avg_score in a separate query without accessed/progress.",
          });
        }
        if (sortSignal === "avg_score" && !signals.includes("avg_score")) {
          throw new AppError(
            "invalid_input",
            "sort on avg_score is not possible here: avg_score was skipped.",
          );
        }
        if (signals.includes("web_course_access")) warnings.push(SIGNALS.web_course_access.caveat!);
        if (window && signals.includes("accessed")) warnings.push(SIGNALS.accessed.caveat!);
        if (window?.semantics === "last_access_in_range") warnings.push(window.description);
        const categoryNames = groupBy.includes("category")
          ? new Map((await port.listCategories()).map((x) => [x.id, x.name]))
          : undefined;

        const c: RunCtx = {
          deps,
          port,
          t,
          args,
          courses,
          coursesById: new Map(courses.map((x) => [x.id, x])),
          categoryNames,
          groupBy,
          unit,
          window,
          signals,
          warnings,
          filters: resolved.filters,
          validOnly: resolved.validOnly,
          qh: queryHash(args),
        };
        const prev = args.cursor ? decodeCursor(args.cursor, deps.cursorSecret, c.qh) : null;
        const result = wantsPerPerson
          ? await runPeople(c, prev?.state as PeopleState | undefined)
          : unit === "enrolments"
            ? await runPages(c, prev?.state as PagesState | undefined, prev?.done ?? [])
            : await runSingle(c);

        return buildEnvelope({
          tenant: t,
          environment: deps.env,
          source: port.source,
          nowSec: now,
          courses,
          filters: resolved.applied,
          window,
          warnings,
          data: { ...result, skipped_signals: skipped.length ? skipped : undefined },
        });
      }),
  );
}

interface RunCtx {
  deps: ToolDeps;
  port: LearningDataPort;
  t: TenantConfig;
  args: {
    limit: number;
    sort: string;
    cursor?: string | undefined;
    filters?: Record<string, string[] | undefined> | undefined;
  };
  courses: Course[];
  coursesById: Map<number, Course>;
  categoryNames: Map<number, string> | undefined;
  filters: Filters;
  validOnly: boolean;
  groupBy: GroupDim[];
  unit: Unit;
  window: AccessWindow | null;
  signals: SignalId[];
  warnings: string[];
  qh: string;
}

// ---------------------------------------------------------------- single

/** Account-level counts without per-person signals: the whole scope must load in one call. */
async function runSingle(c: RunCtx) {
  if (c.args.cursor)
    throw new AppError("invalid_input", "This query is answered in one part; remove the cursor.");
  const { observed, pop, selected } = await loadWholeScope(c);
  const scores = await maybeScores(c, c.courses);
  const opts = aggOpts(c, null, scores);
  const rows = aggregate(selected, { ...opts, groupBy: c.groupBy });
  const tot = aggregate(selected, { ...opts, groupBy: [] })[0] ?? emptyPartial();
  notes(c, selected, observed);
  return finalAnswer(c, rows, tot, pop);
}

function aggOpts(
  c: RunCtx,
  personCourses: AggregateInput["personCourses"],
  scores: AggregateInput["scores"],
  unit: Unit = c.unit,
): Omit<AggregateInput, "groupBy"> {
  return { unit, window: c.window, personCourses, scores, categoryNames: c.categoryNames };
}

async function loadWholeScope(c: RunCtx) {
  let scope;
  try {
    scope = await loadScope(c.port, c.t, c.courses, c.filters);
  } catch (err) {
    if (err instanceof AppError && err.code === "scope_too_large") {
      throw new AppError(
        "scope_too_large",
        `Loading every ${c.t.vocabulary.person.toLowerCase()} across ${c.courses.length} ${c.t.vocabulary.coursePlural.toLowerCase()} does not fit one call. ` +
          "Narrow it (fewer courses or a region/level/branch filter), or use count_by='enrolments' with " +
          "logged_in / web_course_access / avg_score, which is answered in parts.",
      );
    }
    throw err;
  }
  const pop = populationCounts(scope.records, c.unit);
  const selected = selectPopulation(scope.records, c.validOnly);
  return { observed: scope.observedRegions, pop, selected };
}

// ---------------------------------------------------------------- people

/**
 * Per-person signals in batches of accounts. The account list is re-derived live each call and
 * resumption is by the LAST PROCESSED account key (not an index), so accounts added or removed
 * between parts never shift the position.
 */
async function runPeople(c: RunCtx, prev: PeopleState | undefined) {
  const { observed, pop, selected } = await loadWholeScope(c);
  const byKey = new Map<string, EnrolmentRecord[]>();
  for (const r of selected) {
    const key = `u:${String(r.person.userId).padStart(12, "0")}`;
    const list = byKey.get(key);
    if (list) list.push(r);
    else byKey.set(key, [r]);
  }
  const keys = [...byKey.keys()].sort();
  const state = {
    after: prev?.after ?? null,
    acc: prev ? unpackRows(c, prev.acc) : [],
    tot: prev ? unpackRow(c, prev.tot, []) : emptyPartial(),
  };
  let idx = state.after === null ? 0 : upperBound(keys, state.after);
  const batch = c.t.limits.upstreamConcurrency * 10;
  let processed = 0;
  const started = Date.now();
  while (idx < keys.length) {
    if (processed > 0 && remainingBudgetMs() < ((Date.now() - started) / processed) * batch * 1.3) break;
    const slice = keys.slice(idx, idx + batch);
    const recs = slice.flatMap((k) => byKey.get(k)!);
    let personCourses;
    try {
      assertWithinBudget();
      personCourses = await loadPersonCourses(c.port, c.t, [...new Set(recs.map((r) => r.person.userId))]);
    } catch (err) {
      if (processed > 0 && isOutOfTime(err)) break;
      throw err;
    }
    const opts = aggOpts(c, personCourses, null);
    state.acc = mergePartials(state.acc, aggregate(recs, { ...opts, groupBy: c.groupBy }));
    state.tot = mergePartials([state.tot], aggregate(recs, { ...opts, groupBy: [] }))[0] ?? state.tot;
    idx += slice.length;
    processed += slice.length;
    state.after = slice[slice.length - 1]!;
    if (idx < keys.length)
      ensureFits(c, {
        m: "people",
        after: state.after,
        acc: packRows(c, state.acc),
        tot: packRow(c, state.tot, []),
      });
  }
  notes(c, selected, observed);
  const progress = { accounts_done: idx, accounts_total: keys.length };
  if (idx >= keys.length) return { ...finalAnswer(c, state.acc, state.tot, pop), progress };
  c.warnings.push(
    `Partial answer: ${idx} of ${keys.length} accounts processed. ` +
      "Call query_metrics again with the same arguments and next_cursor.",
  );
  const next: PeopleState = {
    m: "people",
    after: state.after,
    acc: packRows(c, state.acc),
    tot: packRow(c, state.tot, []),
  };
  return {
    unit: c.unit,
    complete: false,
    progress,
    next_cursor: encodeCursor({ v: 1, q: c.qh, done: [], state: next }, c.deps.cursorSecret),
    rows_total: 0,
    rows: [],
  };
}

/** First index whose key is greater than `after`. */
function upperBound(keys: string[], after: string): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]! <= after) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------- pages

/** Enrolment-level answers, one page of one course at a time. Rows come with the last part. */
async function runPages(c: RunCtx, prev: PagesState | undefined, doneIds: number[]) {
  let cid = prev?.cid ?? null;
  let off = prev?.off ?? 0;
  let acc = prev ? unpackRows(c, prev.acc) : [];
  let tot = prev ? unpackRow(c, prev.tot, []) : emptyPartial();
  let pop: PopulationCounts = prev?.pop ?? emptyCounts();
  const observed = new Set<string>(prev?.obs ?? []);
  const done = new Set(doneIds);
  const seen: EnrolmentRecord[] = [];
  const scoresByCourse = new Map<number, Awaited<ReturnType<typeof maybeScores>>>();
  const snapshot = (): PagesState => ({
    m: "pages",
    cid,
    off,
    acc: packRows(c, acc),
    tot: packRow(c, tot, []),
    pop,
    obs: [...observed],
  });
  let pages = 0;
  const started = Date.now();

  for (const course of c.courses) {
    if (done.has(course.id)) continue;
    if (cid !== course.id) {
      cid = course.id;
      off = 0;
    }
    let finished = false;
    while (!finished) {
      if (pages > 0 && remainingBudgetMs() < ((Date.now() - started) / pages) * 1.3) break;
      let page;
      let scores = scoresByCourse.get(course.id) ?? null;
      try {
        assertWithinBudget();
        page = await loadScopePage(c.port, c.t, course, off, c.filters);
        if (!scoresByCourse.has(course.id)) {
          scores = await maybeScores(c, [course]);
          scoresByCourse.set(course.id, scores);
        }
      } catch (err) {
        if (pages > 0 && isOutOfTime(err)) break;
        if (isOutOfTime(err)) {
          throw new AppError(
            "upstream_unavailable",
            "The LMS is too slow to return even one page right now. Try again shortly.",
          );
        }
        throw err;
      }
      page.observedRegions.forEach((r) => observed.add(r));
      pop = addCounts(pop, populationCounts(page.records, "enrolments"));
      const selected = selectPopulation(page.records, c.validOnly);
      seen.push(...selected);
      const opts = aggOpts(c, null, scores, "enrolments");
      acc = mergePartials(acc, aggregate(selected, { ...opts, groupBy: c.groupBy }));
      tot = mergePartials([tot], aggregate(selected, { ...opts, groupBy: [] }))[0] ?? tot;
      pages++;
      if (page.done) {
        finished = true;
        done.add(course.id);
        cid = null;
        off = 0;
      } else {
        off += c.t.limits.participantsPageSize;
      }
      if (done.size < c.courses.length) ensureFits(c, snapshot(), [...done]);
    }
    if (!finished) break;
  }

  notes(c, seen, observed);
  const progress = {
    courses_done: done.size,
    courses_total: c.courses.length,
    ...(cid !== null ? { course_in_progress: cid } : {}),
  };
  if (done.size === c.courses.length) return { ...finalAnswer(c, acc, tot, pop), progress };
  c.warnings.push(
    `Partial answer: ${done.size} of ${c.courses.length} ${c.t.vocabulary.coursePlural.toLowerCase()} done` +
      (cid !== null ? ` (course ${cid} in progress)` : "") +
      ". Call query_metrics again with the same arguments and next_cursor.",
  );
  return {
    unit: "enrolments" as const,
    complete: false,
    progress,
    next_cursor: encodeCursor({ v: 1, q: c.qh, done: [...done], state: snapshot() }, c.deps.cursorSecret),
    rows_total: 0,
    rows: [],
  };
}

// ---------------------------------------------------------------- shared

/** Fail fast (before doing more work) when the running state can no longer fit a cursor. */
function ensureFits(c: RunCtx, state: PagesState | PeopleState, done: number[] = []): void {
  const payload: CursorPayload = { v: 1, q: c.qh, done, state };
  if (!cursorFits(payload)) {
    throw new AppError(
      "scope_too_large",
      "This breakdown has too many groups to answer in parts. Group by course or by fewer dimensions, or add a filter (e.g. one region).",
    );
  }
}

/** `dims` = the row's grouping: c.groupBy for group rows, [] for totals. */
function packRow(c: RunCtx, r: PartialRow, dims: GroupDim[] = c.groupBy): Packed {
  const g = dims.map((d) =>
    d === "course" ? r.group.course!.id : d === "category" ? r.group.category!.id : r.group[d]!,
  );
  const nums = NUMERIC_FIELDS.map((f) => r[f]);
  while (nums.length && nums[nums.length - 1] === 0) nums.pop();
  return [g, ...nums];
}

function unpackRow(c: RunCtx, p: Packed, dims: GroupDim[] = c.groupBy): PartialRow {
  const [g, ...nums] = p;
  const group: GroupKey = {};
  dims.forEach((d, i) => {
    const value = g[i]!;
    if (d === "course") {
      const course = c.coursesById.get(Number(value));
      group.course = { id: Number(value), name: course?.fullName ?? String(value) };
    } else if (d === "category") {
      group.category = { id: Number(value), name: c.categoryNames?.get(Number(value)) ?? null };
    } else {
      group[d] = String(value);
    }
  });
  const row = { ...emptyPartial(), group };
  NUMERIC_FIELDS.forEach((f, i) => (row[f] = nums[i] ?? 0));
  return row;
}

const packRows = (c: RunCtx, rows: PartialRow[]) => rows.map((r) => packRow(c, r));
const unpackRows = (c: RunCtx, rows: Packed[]) => rows.map((r) => unpackRow(c, r));

function finalAnswer(c: RunCtx, rows: PartialRow[], tot: PartialRow, pop: PopulationCounts) {
  const windowed = c.window !== null;
  const sorted = sortMetricRows(
    rows.map((r) => finalize(r, c.signals, windowed)),
    c.args.sort,
  );
  return {
    unit: c.unit,
    complete: true,
    next_cursor: null,
    population: populationOut(pop, c.t, c.validOnly),
    totals: finalize(tot, c.signals, windowed, false),
    sort: c.args.sort,
    rows_total: sorted.length,
    rows: sorted.slice(0, c.args.limit),
  };
}

async function maybeScores(c: RunCtx, courses: Course[]) {
  if (!c.signals.includes("avg_score")) return null;
  return loadScores(
    c.port,
    c.t,
    courses.map((x) => x.id),
  );
}

function notes(c: RunCtx, selected: EnrolmentRecord[], observed: Set<string>): void {
  if (
    (c.signals.includes("logged_in") || c.signals.includes("accessed")) &&
    selected.length >= 20 &&
    selected.every((r) => r.lastSiteAccess === null)
  ) {
    c.warnings.push(
      "No sign-in dates came back at all: the LMS may be hiding last access from the service account.",
    );
  }
  c.warnings.push(
    ...dataWarnings(
      c.t,
      selected.map((r) => r.person),
    ),
  );
  const filterRegions = c.filters.include.region;
  if (!c.groupBy.includes("region") && !filterRegions?.length && !c.filters.exclude.region?.length) return;
  c.warnings.push(regionSourceNote(c.t));
  c.warnings.push(...familyNotes(c.t.dimensions.region.label, [...observed], filterRegions));
}
