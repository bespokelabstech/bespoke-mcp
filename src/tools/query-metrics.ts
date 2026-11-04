import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { assertWithinBudget } from "@/core/concurrency";
import { decodeCursor, encodeCursor, queryHash } from "@/core/cursor";
import { AppError } from "@/core/errors";
import { loadPersonCourses, loadScores } from "@/domain/enrich";
import { buildEnvelope } from "@/domain/envelope";
import type { AggregateInput, GroupDim, PartialRow, Unit } from "@/domain/metrics";
import { aggregate, emptyPartial, finalize, mergePartials, sortRows } from "@/domain/metrics";
import { familyNotes } from "@/domain/people";
import type { EnrolmentRecord, StatusCounts } from "@/domain/population";
import { loadScope, loadScopePage, selectPopulation, statusCounts } from "@/domain/population";
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
 *  - single: everything fits one call.
 *  - pages:  enrolment-level, no per-person signals — work unit = one page of one course, so
 *            even very large courses split across calls. Results are additive.
 *  - people: per-person signals (started, completion) over more people than fit one call —
 *            work unit = a batch of people; each person's single LMS call covers all courses.
 * Parts continue via a signed cursor carrying progress and running sums; nothing is stored.
 */
type PagesState = {
  m: "pages";
  cid: number | null;
  off: number;
  acc: PartialRow[];
  cur: PartialRow[];
  tot: PartialRow;
  pop: StatusCounts;
};
type PeopleState = { m: "people"; idx: number; acc: PartialRow[]; tot: PartialRow };

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
      .max(10_000)
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
        `With group_by course, each part's course rows are final; otherwise rows and totals come with the last part. ` +
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
        if (signals.includes("avg_score") && !(await port.capabilities()).grades) {
          signals = signals.filter((s) => s !== "avg_score");
          skipped.push({
            signal: "avg_score",
            reason: "The LMS service does not include the grade report function.",
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
          groupBy,
          unit,
          window,
          signals,
          warnings,
          statuses: toStatuses(args.population, t),
          qh: queryHash(args),
        };
        const wantsPerPerson = signals.some((s) => PER_PERSON.includes(s));
        const cursorMode = args.cursor ? decodeCursor(args.cursor, deps.cursorSecret, c.qh) : null;
        const result =
          cursorMode?.state && (cursorMode.state as PeopleState).m === "people"
            ? await runPeople(c, cursorMode.state as PeopleState)
            : unit === "enrolments" && !wantsPerPerson
              ? await runPages(c, cursorMode?.state as PagesState | undefined, cursorMode?.done ?? [])
              : await runSingleOrPeople(c);

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

/** Load the whole scope in this call, then answer at once or switch to people batches. */
async function runSingleOrPeople(c: RunCtx) {
  const { observed, pop, selected } = await loadWholeScope(c);
  const ids = [...new Set(selected.map((r) => r.person.userId))];
  const wantsPerPerson = c.signals.some((s) => PER_PERSON.includes(s));
  if (wantsPerPerson && ids.length > c.t.limits.maxPeopleForPersonSignals) {
    return runPeople(c, { m: "people", idx: 0, acc: [], tot: emptyPartial() }, { observed, pop, selected });
  }
  const personCourses = wantsPerPerson ? await loadPersonCourses(c.port, c.t, ids) : null;
  const scores = await maybeScores(c, c.courses);
  const opts: Omit<AggregateInput, "groupBy"> = { unit: c.unit, window: c.window, personCourses, scores };
  const rows = sortRows(aggregate(selected, { ...opts, groupBy: c.groupBy }));
  const tot = aggregate(selected, { ...opts, groupBy: [] })[0] ?? emptyPartial();
  notes(c, selected, observed);
  return finalAnswer(c, rows, tot, pop);
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
  return { observed: scope.observedRegions, pop, selected };
}

/** Per-person signals in batches of people; the person list is re-derived live each call. */
async function runPeople(c: RunCtx, state: PeopleState, loaded?: Awaited<ReturnType<typeof loadWholeScope>>) {
  const { observed, pop, selected } = loaded ?? (await loadWholeScope(c));
  // Stable order of people (not accounts), so duplicate accounts stay in the same batch.
  const byKey = new Map<string, EnrolmentRecord[]>();
  for (const r of selected) byKey.set(r.person.key, [...(byKey.get(r.person.key) ?? []), r]);
  const keys = [...byKey.keys()].sort();
  const scores = await maybeScores(c, c.courses);
  const batch = c.t.limits.upstreamConcurrency * 10;
  let processed = 0;
  const started = Date.now();
  while (state.idx < keys.length) {
    if (processed > 0 && remainingBudgetMs() < ((Date.now() - started) / processed) * batch * 1.3) break;
    const slice = keys.slice(state.idx, state.idx + batch);
    const recs = slice.flatMap((k) => byKey.get(k)!);
    let personCourses;
    try {
      assertWithinBudget();
      personCourses = await loadPersonCourses(c.port, c.t, [...new Set(recs.map((r) => r.person.userId))]);
    } catch (err) {
      if (processed > 0 && isOutOfTime(err)) break;
      throw err;
    }
    const opts: Omit<AggregateInput, "groupBy"> = { unit: c.unit, window: c.window, personCourses, scores };
    state.acc = mergePartials(state.acc, aggregate(recs, { ...opts, groupBy: c.groupBy }));
    state.tot = mergePartials([state.tot], aggregate(recs, { ...opts, groupBy: [] }))[0] ?? state.tot;
    state.idx += slice.length;
    processed += slice.length;
  }
  notes(c, selected, observed);
  const complete = state.idx >= keys.length;
  const progress = { people_done: Math.min(state.idx, keys.length), people_total: keys.length };
  if (complete) return { ...finalAnswer(c, sortRows(state.acc), state.tot, pop), progress };
  c.warnings.push(
    `Partial answer: ${progress.people_done} of ${progress.people_total} ${c.t.vocabulary.personPlural.toLowerCase()} processed. ` +
      "Call query_metrics again with the same arguments and next_cursor.",
  );
  return {
    unit: c.unit,
    complete: false,
    progress,
    next_cursor: encodeCursor({ v: 1, q: c.qh, done: [], state }, c.deps.cursorSecret),
    rows_total: 0,
    rows: [],
  };
}

/** Enrolment-level answers, one page of one course at a time. */
async function runPages(c: RunCtx, prev: PagesState | undefined, doneIds: number[]) {
  const byCourse = c.groupBy.includes("course");
  const state: PagesState = prev ?? {
    m: "pages",
    cid: null,
    off: 0,
    acc: [],
    cur: [],
    tot: emptyPartial(),
    pop: { person: 0, legacy: 0, excluded: 0 },
  };
  const done = new Set(doneIds);
  const pageRows: PartialRow[] = [];
  const seen: EnrolmentRecord[] = [];
  const observed = new Set<string>();
  let pages = 0;
  const started = Date.now();

  for (const course of c.courses) {
    if (done.has(course.id)) continue;
    if (state.cid !== course.id) {
      state.cid = course.id;
      state.off = 0;
      state.cur = [];
    }
    let finished = false;
    while (!finished) {
      if (pages > 0 && remainingBudgetMs() < ((Date.now() - started) / pages) * 1.3) break;
      let page;
      let scores = null;
      try {
        assertWithinBudget();
        page = await loadScopePage(c.port, c.t, course, state.off, c.args.filters ?? {});
        scores = await maybeScores(c, [course]);
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
      const pop = statusCounts(page.records, "enrolments");
      state.pop = {
        person: state.pop.person + pop.person,
        legacy: state.pop.legacy + pop.legacy,
        excluded: state.pop.excluded + pop.excluded,
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
      if (byCourse) state.cur = mergePartials(state.cur, part);
      else state.acc = mergePartials(state.acc, part);
      state.tot = mergePartials([state.tot], aggregate(selected, { ...opts, groupBy: [] }))[0] ?? state.tot;
      pages++;
      if (page.done) {
        finished = true;
        done.add(course.id);
        if (byCourse) pageRows.push(...state.cur);
        state.cid = null;
        state.off = 0;
        state.cur = [];
      } else {
        state.off += c.t.limits.participantsPageSize;
      }
    }
    if (!finished) break;
  }

  notes(c, seen, observed);
  const complete = done.size === c.courses.length;
  if (complete) {
    const rows = sortRows(byCourse ? pageRows : state.acc);
    return {
      ...finalAnswer(c, rows, state.tot, state.pop),
      progress: { courses_done: done.size, courses_total: c.courses.length },
    };
  }
  c.warnings.push(
    `Partial answer: ${done.size} of ${c.courses.length} ${c.t.vocabulary.coursePlural.toLowerCase()} done` +
      (state.cid !== null ? ` (course ${state.cid} in progress)` : "") +
      ". Call query_metrics again with the same arguments and next_cursor.",
  );
  const rows = sortRows(pageRows);
  return {
    unit: "enrolments" as const,
    complete: false,
    progress: {
      courses_done: done.size,
      courses_total: c.courses.length,
      ...(state.cid !== null ? { course_in_progress: state.cid } : {}),
    },
    next_cursor: encodeCursor({ v: 1, q: c.qh, done: [...done], state }, c.deps.cursorSecret),
    rows_total: rows.length,
    rows: rows.slice(0, c.args.limit).map((r) => finalize(r, c.signals, c.window !== null)),
  };
}

function finalAnswer(c: RunCtx, rows: PartialRow[], tot: PartialRow, pop: StatusCounts) {
  return {
    unit: c.unit,
    complete: true,
    next_cursor: null,
    population: labelledCounts(pop, c.t),
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
