import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { assertWithinBudget } from "@/core/concurrency";
import type { CursorPayload } from "@/core/cursor";
import { cursorFits, decodeCursor, encodeCursor, queryHash } from "@/core/cursor";
import { AppError } from "@/core/errors";
import { loadPersonCourses, loadScores } from "@/domain/enrich";
import { buildEnvelope } from "@/domain/envelope";
import type { AggregateInput, GroupDim, GroupKey, PartialRow, Unit } from "@/domain/metrics";
import { aggregate, emptyPartial, finalize, mergePartials, NUMERIC_FIELDS, sortRows } from "@/domain/metrics";
import { familyNotes } from "@/domain/people";
import type { EnrolmentRecord, StatusCounts } from "@/domain/population";
import {
  loadScope,
  loadScopePage,
  mergedDuplicateAccounts,
  selectPopulation,
  statusCounts,
} from "@/domain/population";
import { resolveCourseScope } from "@/domain/scope";
import type { SignalId } from "@/domain/signals";
import { DEFAULT_SIGNALS, SIGNALS } from "@/domain/signals";
import type { AccessWindow } from "@/domain/time";
import { resolveWindow } from "@/domain/time";
import type { Course, LearningDataPort } from "@/ports/learning";
import type { TenantConfig } from "@/tenants/schema";
import type { ToolDeps } from "./runtime";
import { READ_ONLY_ANNOTATIONS, remainingBudgetMs, requireLearning, runTool } from "./runtime";
import {
  filtersField,
  labelledCounts,
  populationField,
  scopeFields,
  signalsField,
  toStatuses,
  windowFields,
} from "./shared-schemas";

const PER_PERSON: SignalId[] = ["started", "completion"];

/**
 * Three ways to answer, chosen automatically:
 *  - single: enrolment-level or people-level without per-person signals, fits one call.
 *  - pages:  enrolment-level, no per-person signals — work unit = one page of one course, so
 *            even very large courses split across calls. Results are additive.
 *  - people: per-person signals (started, completion) — work unit = a batch of people (one LMS
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
  cur: Packed[];
  tot: Packed;
  pop: StatusCounts;
  obs: string[];
};
type PeopleState = { m: "people"; after: string | null; acc: Packed[]; tot: Packed };

export function registerQueryMetrics(server: McpServer, deps: ToolDeps): void {
  const t = deps.tenant;
  const v = t.vocabulary;
  const people = v.personPlural.toLowerCase();
  const inputSchema = z.object({
    ...scopeFields(t),
    filters: filtersField(t),
    population: populationField(t),
    group_by: z
      .array(z.enum(["region", "level", "branch", "course"]))
      .max(2)
      .default([])
      .describe("Zero, one or two dimensions to group by. Empty = totals only."),
    count_by: z
      .enum(["people", "enrolments"])
      .default("people")
      .describe(
        `people = each ${v.person.toLowerCase()} once per group (duplicate accounts with the same ${t.identity.label} merge); ` +
          `enrolments = each account-${v.course.toLowerCase()} enrolment as Moodle records it. Grouping by course always counts enrolments.`,
      ),
    signals: signalsField,
    ...windowFields(t),
    limit: z.number().int().min(1).max(500).default(50).describe("Max rows returned (largest groups first)."),
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
        `Count ${people} and their engagement signals (started, completion, app/site access, web course access, average score), ` +
        `grouped by ${t.dimensions.region.label}, ${t.dimensions.level.label}, ${t.dimensions.branch.label} and/or ${v.course}. ` +
        `Large questions are answered in parts: while complete=false, call again with the same arguments plus next_cursor. ` +
        `With group_by course and no per-person signals, each part's course rows are final; otherwise rows and totals come with the last part. ` +
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
        const courses = await resolveCourseScope(port, t, args);
        const warnings: string[] = [];
        const skipped: Array<{ signal: SignalId; reason: string }> = [];

        let signals: SignalId[] = [...new Set(args.signals ?? DEFAULT_SIGNALS)];
        const wantsPerPerson = signals.some((s) => PER_PERSON.includes(s));
        if (signals.includes("avg_score") && !(await port.capabilities()).grades) {
          signals = signals.filter((s) => s !== "avg_score");
          skipped.push({
            signal: "avg_score",
            reason: "The LMS service does not include the grade report function.",
          });
        } else if (signals.includes("avg_score") && wantsPerPerson) {
          // Grade reports are per course (all users at once); repeating them in every
          // people batch would consume the time budget. avg_score is enrolment-based anyway.
          signals = signals.filter((s) => s !== "avg_score");
          skipped.push({
            signal: "avg_score",
            reason: "Ask for avg_score in a separate query without started/completion.",
          });
        }
        if (signals.includes("web_course_access")) warnings.push(SIGNALS.web_course_access.caveat!);
        if (window?.semantics === "last_access_in_range") warnings.push(window.description);

        const c: RunCtx = {
          deps,
          port,
          t,
          args,
          courses,
          coursesById: new Map(courses.map((x) => [x.id, x])),
          groupBy,
          unit,
          window,
          signals,
          warnings,
          statuses: toStatuses(args.population, t),
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
          filters: args.filters,
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
    cursor?: string | undefined;
    filters?: Record<string, string[] | undefined> | undefined;
  };
  courses: Course[];
  coursesById: Map<number, Course>;
  statuses: ReturnType<typeof toStatuses>;
  groupBy: GroupDim[];
  unit: Unit;
  window: AccessWindow | null;
  signals: SignalId[];
  warnings: string[];
  qh: string;
}

const isOutOfTime = (err: unknown) =>
  err instanceof AppError && (err.code === "scope_too_large" || err.code === "upstream_unavailable");

// ---------------------------------------------------------------- single

/** People-level counts without per-person signals: the whole scope must load in one call. */
async function runSingle(c: RunCtx) {
  if (c.args.cursor)
    throw new AppError("invalid_input", "This query is answered in one part; remove the cursor.");
  const { observed, pop, selected, merged } = await loadWholeScope(c);
  const scores = await maybeScores(c, c.courses);
  const opts: Omit<AggregateInput, "groupBy"> = {
    unit: c.unit,
    window: c.window,
    personCourses: null,
    scores,
  };
  const rows = sortRows(aggregate(selected, { ...opts, groupBy: c.groupBy }));
  const tot = aggregate(selected, { ...opts, groupBy: [] })[0] ?? emptyPartial();
  notes(c, selected, observed);
  return finalAnswer(c, rows, tot, pop, merged);
}

async function loadWholeScope(c: RunCtx) {
  let scope;
  try {
    scope = await loadScope(c.port, c.t, c.courses, c.args.filters ?? {});
  } catch (err) {
    if (isOutOfTime(err)) {
      throw new AppError(
        "scope_too_large",
        `Loading every ${c.t.vocabulary.person.toLowerCase()} across ${c.courses.length} ${c.t.vocabulary.coursePlural.toLowerCase()} does not fit one call. ` +
          "Narrow it (fewer courses or a region/level/branch filter), or use count_by='enrolments' with " +
          "site_last_access / web_course_access / avg_score, which is answered in parts.",
      );
    }
    throw err;
  }
  const pop = statusCounts(scope.records, c.unit);
  const selected = selectPopulation(scope.records, c.statuses);
  const merged = c.unit === "people" ? mergedDuplicateAccounts(scope.records) : 0;
  return { observed: scope.observedRegions, pop, selected, merged };
}

// ---------------------------------------------------------------- people

/**
 * Per-person signals in batches of people. The person list is re-derived live each call and
 * resumption is by the LAST PROCESSED counting key (not an index), so people added or removed
 * between parts never shift the position. Duplicate accounts share a key and stay together.
 */
async function runPeople(c: RunCtx, prev: PeopleState | undefined) {
  const { observed, pop, selected, merged } = await loadWholeScope(c);
  const byKey = new Map<string, EnrolmentRecord[]>();
  for (const r of selected) {
    const list = byKey.get(r.person.key);
    if (list) list.push(r);
    else byKey.set(r.person.key, [r]);
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
    const opts: Omit<AggregateInput, "groupBy"> = {
      unit: c.unit,
      window: c.window,
      personCourses,
      scores: null,
    };
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
  const progress = { people_done: idx, people_total: keys.length };
  if (idx >= keys.length) return { ...finalAnswer(c, sortRows(state.acc), state.tot, pop, merged), progress };
  c.warnings.push(
    `Partial answer: ${idx} of ${keys.length} ${c.t.vocabulary.personPlural.toLowerCase()} processed. ` +
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

/** Enrolment-level answers, one page of one course at a time. */
async function runPages(c: RunCtx, prev: PagesState | undefined, doneIds: number[]) {
  const byCourse = c.groupBy.includes("course");
  let cid = prev?.cid ?? null;
  let off = prev?.off ?? 0;
  let acc = prev ? unpackRows(c, prev.acc) : [];
  let cur = prev ? unpackRows(c, prev.cur) : [];
  let tot = prev ? unpackRow(c, prev.tot, []) : emptyPartial();
  let pop: StatusCounts = prev?.pop ?? { person: 0, legacy: 0, excluded: 0 };
  const observed = new Set<string>(prev?.obs ?? []);
  const done = new Set(doneIds);
  const pageRows: PartialRow[] = [];
  const seen: EnrolmentRecord[] = [];
  const scoresByCourse = new Map<number, Awaited<ReturnType<typeof maybeScores>>>();
  const snapshot = (): PagesState => ({
    m: "pages",
    cid,
    off,
    acc: packRows(c, acc),
    cur: packRows(c, cur),
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
      cur = [];
    }
    let finished = false;
    while (!finished) {
      if (pages > 0 && remainingBudgetMs() < ((Date.now() - started) / pages) * 1.3) break;
      let page;
      let scores = scoresByCourse.get(course.id) ?? null;
      try {
        assertWithinBudget();
        page = await loadScopePage(c.port, c.t, course, off, c.args.filters ?? {});
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
      const p = statusCounts(page.records, "enrolments");
      pop = {
        person: pop.person + p.person,
        legacy: pop.legacy + p.legacy,
        excluded: pop.excluded + p.excluded,
      };
      const selected = selectPopulation(page.records, c.statuses);
      seen.push(...selected);
      const opts: Omit<AggregateInput, "groupBy"> = {
        unit: "enrolments",
        window: c.window,
        personCourses: null,
        scores,
      };
      const part = aggregate(selected, { ...opts, groupBy: c.groupBy });
      if (byCourse) cur = mergePartials(cur, part);
      else acc = mergePartials(acc, part);
      tot = mergePartials([tot], aggregate(selected, { ...opts, groupBy: [] }))[0] ?? tot;
      pages++;
      if (page.done) {
        finished = true;
        done.add(course.id);
        if (byCourse) pageRows.push(...cur);
        cid = null;
        off = 0;
        cur = [];
      } else {
        off += c.t.limits.participantsPageSize;
      }
      if (done.size < c.courses.length) ensureFits(c, snapshot(), [...done]);
    }
    if (!finished) break;
  }

  notes(c, seen, observed);
  const complete = done.size === c.courses.length;
  if (complete) {
    const rows = sortRows(byCourse ? pageRows : acc);
    return {
      ...finalAnswer(c, rows, tot, pop),
      progress: { courses_done: done.size, courses_total: c.courses.length },
    };
  }
  c.warnings.push(
    `Partial answer: ${done.size} of ${c.courses.length} ${c.t.vocabulary.coursePlural.toLowerCase()} done` +
      (cid !== null ? ` (course ${cid} in progress)` : "") +
      ". Call query_metrics again with the same arguments and next_cursor.",
  );
  const rows = sortRows(pageRows);
  return {
    unit: "enrolments" as const,
    complete: false,
    progress: {
      courses_done: done.size,
      courses_total: c.courses.length,
      ...(cid !== null ? { course_in_progress: cid } : {}),
    },
    next_cursor: encodeCursor({ v: 1, q: c.qh, done: [...done], state: snapshot() }, c.deps.cursorSecret),
    rows_total: rows.length,
    rows: rows.slice(0, c.args.limit).map((r) => finalize(r, c.signals, c.window !== null)),
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
  const g = dims.map((d) => (d === "course" ? r.group.course!.id : r.group[d]!));
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

function finalAnswer(c: RunCtx, rows: PartialRow[], tot: PartialRow, pop: StatusCounts, merged = 0) {
  return {
    unit: c.unit,
    complete: true,
    next_cursor: null,
    population: labelledCounts(pop, c.t, merged),
    totals: finalize(tot, c.signals, c.window !== null, false),
    rows_total: rows.length,
    rows: rows.slice(0, c.args.limit).map((r) => finalize(r, c.signals, c.window !== null)),
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
    c.signals.includes("site_last_access") &&
    selected.length >= 20 &&
    selected.every((r) => r.lastSiteAccess === null)
  ) {
    c.warnings.push(
      "No site access dates came back at all: the LMS may be hiding last access from the service account.",
    );
  }
  const filterRegions = c.args.filters?.region;
  if (!c.groupBy.includes("region") && !filterRegions?.length) return;
  c.warnings.push(...familyNotes(c.t.dimensions.region.label, [...observed], filterRegions));
}
