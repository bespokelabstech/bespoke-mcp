import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { decodeCursor, encodeCursor, queryHash } from "@/core/cursor";
import { AppError } from "@/core/errors";
import { loadPersonCourses, loadScores } from "@/domain/enrich";
import { buildEnvelope } from "@/domain/envelope";
import type { GroupDim, PartialRow, Unit } from "@/domain/metrics";
import { aggregate, emptyPartial, finalize, mergePartials, sortRows } from "@/domain/metrics";
import { familyNotes } from "@/domain/people";
import type { EnrolmentRecord, StatusCounts } from "@/domain/population";
import { loadScope, selectPopulation, statusCounts } from "@/domain/population";
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

interface CursorState {
  acc: PartialRow[];
  tot: PartialRow;
  pop: StatusCounts;
}

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
          `enrolments = each ${v.person.toLowerCase()}-${v.course.toLowerCase()} pair. Grouping by course always counts enrolments.`,
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
        `Use for questions like "started rate per ${t.dimensions.region.label}" or "completion per ${v.course}". ` +
        `Large enrolment-level questions are answered in parts: if 'next_cursor' is returned, call again with the same arguments plus cursor ` +
        `until complete=true; per-${v.course.toLowerCase()} rows from each part are final, totals come with the last part. ` +
        `Report numbers exactly as returned; never recompute or estimate.`,
      inputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) =>
      runTool("query_metrics", deps, args, async () => {
        const port = requireLearning(deps);
        const now = deps.nowSec();
        const window = resolveWindow(args, t.timezone, now);
        const statuses = toStatuses(args.population, t);
        const groupBy = args.group_by as GroupDim[];
        const unit: Unit = groupBy.includes("course") ? "enrolments" : args.count_by;
        const courses = await resolveCourseScope(port, t, args);
        const warnings: string[] = [];

        let signals: SignalId[] = [...new Set(args.signals ?? DEFAULT_SIGNALS)];
        if (signals.includes("avg_score") && !(await port.capabilities()).grades) {
          signals = signals.filter((s) => s !== "avg_score");
          warnings.push(
            "avg_score is unavailable: the LMS service does not include the grade report function.",
          );
        }
        for (const s of signals)
          if (SIGNALS[s].caveat && s === "web_course_access") warnings.push(SIGNALS[s].caveat!);
        if (window?.semantics === "last_access_in_range") warnings.push(window.description);

        const wantsPerPerson = signals.some((s) => PER_PERSON.includes(s));
        const inParts = unit === "enrolments" && !wantsPerPerson;
        const ctx: RunCtx = {
          deps,
          port,
          t,
          args,
          courses,
          statuses,
          groupBy,
          unit,
          window,
          signals,
          warnings,
        };
        const result = inParts ? await runInParts(ctx) : await runSinglePass(ctx);

        return buildEnvelope({
          tenant: t,
          environment: deps.env,
          source: port.source,
          nowSec: now,
          courses,
          filters: args.filters,
          window,
          warnings,
          data: result,
        });
      }),
  );
}

interface RunCtx {
  deps: ToolDeps;
  port: LearningDataPort;
  t: TenantConfig;
  args: Record<string, unknown> & {
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
}

/** People-level (or per-person-signal) questions: the whole scope must load in one call. */
async function runSinglePass(c: RunCtx) {
  if (c.args.cursor)
    throw new AppError("invalid_input", "This query is answered in one part; remove the cursor.");
  let records: EnrolmentRecord[];
  let observed: Set<string>;
  try {
    ({ records, observedRegions: observed } = await loadScope(c.port, c.t, c.courses, c.args.filters ?? {}));
  } catch (err) {
    if (err instanceof AppError && err.code === "scope_too_large") {
      throw new AppError(
        "scope_too_large",
        `Too much data to count distinct ${c.t.vocabulary.personPlural.toLowerCase()} across ${c.courses.length} ${c.t.vocabulary.coursePlural.toLowerCase()} in one call. ` +
          "Narrow it (fewer courses, or a region/level/branch filter), or use count_by='enrolments' with signals that do not need per-person calls " +
          "(site_last_access, web_course_access, avg_score) to get it in parts.",
      );
    }
    throw err;
  }
  const pop = statusCounts(records, c.unit);
  const selected = selectPopulation(records, c.statuses);

  let personCourses = null;
  if (c.signals.some((s) => PER_PERSON.includes(s))) {
    const ids = [...new Set(selected.map((r) => r.person.userId))];
    if (ids.length > c.t.limits.maxPeopleForPersonSignals) {
      const dropped = c.signals.filter((s) => PER_PERSON.includes(s));
      c.signals = c.signals.filter((s) => !PER_PERSON.includes(s));
      c.warnings.push(
        `${dropped.join(" and ")} skipped: they need one LMS call per person and this scope has ${ids.length} accounts ` +
          `(live limit ${c.t.limits.maxPeopleForPersonSignals}). Narrow by ${c.t.dimensions.region.label}, ${c.t.dimensions.level.label}, ` +
          `${c.t.dimensions.branch.label} or ${c.t.vocabulary.course}.`,
      );
    } else {
      personCourses = await loadPersonCourses(c.port, c.t, ids);
    }
  }
  const scores = c.signals.includes("avg_score")
    ? await loadScores(
        c.port,
        c.t,
        c.courses.map((x) => x.id),
      )
    : null;

  const opts = { unit: c.unit, window: c.window, personCourses, scores };
  const rows = sortRows(aggregate(selected, { ...opts, groupBy: c.groupBy }));
  const tot = aggregate(selected, { ...opts, groupBy: [] })[0] ?? emptyPartial();
  sanityWarnings(c, selected);
  regionNotes(c, observed);
  return {
    unit: c.unit,
    complete: true,
    population: labelledCounts(pop, c.t),
    totals: finalize(tot, c.signals, c.window !== null, false),
    rows_total: rows.length,
    rows: rows.slice(0, c.args.limit).map((r) => finalize(r, c.signals, c.window !== null)),
  };
}

/** Enrolment-level questions: additive across courses, so they can be answered in parts. */
async function runInParts(c: RunCtx) {
  const qh = queryHash(c.args);
  const byCourse = c.groupBy.includes("course");
  let state: CursorState = { acc: [], tot: emptyPartial(), pop: { person: 0, legacy: 0, excluded: 0 } };
  const done = new Set<number>();
  if (c.args.cursor) {
    const p = decodeCursor(c.args.cursor, c.deps.cursorSecret, qh);
    p.done.forEach((id) => done.add(id));
    state = p.state as CursorState;
  }

  const remaining = c.courses.filter((x) => !done.has(x.id));
  const chunkSize = c.t.limits.upstreamConcurrency;
  const pageRows: PartialRow[] = [];
  const seenRecords: EnrolmentRecord[] = [];
  const observed = new Set<string>();
  let chunks = 0;
  const started = Date.now();
  for (let i = 0; i < remaining.length; i += chunkSize) {
    const chunk = remaining.slice(i, i + chunkSize);
    if (chunks > 0) {
      const perChunk = (Date.now() - started) / chunks;
      if (remainingBudgetMs() < perChunk * 1.3) break;
    }
    let records: EnrolmentRecord[];
    let scores = null;
    try {
      const scope = await loadScope(c.port, c.t, chunk, c.args.filters ?? {});
      records = scope.records;
      scope.observedRegions.forEach((r) => observed.add(r));
      if (c.signals.includes("avg_score")) {
        scores = await loadScores(
          c.port,
          c.t,
          chunk.map((x) => x.id),
        );
      }
    } catch (err) {
      // Out of time after at least one finished chunk: hand back what is done.
      if (err instanceof AppError && err.code === "scope_too_large" && chunks > 0) break;
      if (err instanceof AppError && err.code === "scope_too_large") {
        throw new AppError(
          "scope_too_large",
          `A single ${c.t.vocabulary.course.toLowerCase()} is too large to load in time. Add a region/level/branch filter.`,
        );
      }
      throw err;
    }
    const pop = statusCounts(records, "enrolments");
    state.pop = {
      person: state.pop.person + pop.person,
      legacy: state.pop.legacy + pop.legacy,
      excluded: state.pop.excluded + pop.excluded,
    };
    const selected = selectPopulation(records, c.statuses);
    seenRecords.push(...selected);
    const opts = { unit: "enrolments" as const, window: c.window, personCourses: null, scores };
    const part = aggregate(selected, { ...opts, groupBy: c.groupBy });
    state.tot = mergePartials([state.tot], aggregate(selected, { ...opts, groupBy: [] }))[0] ?? state.tot;
    if (byCourse) pageRows.push(...part);
    else state.acc = mergePartials(state.acc, part);
    chunk.forEach((x) => done.add(x.id));
    chunks++;
  }

  const complete = done.size === c.courses.length;
  sanityWarnings(c, seenRecords);
  regionNotes(c, observed);
  const rows = sortRows(byCourse ? pageRows : complete ? state.acc : []);
  const next = complete
    ? null
    : encodeCursor(
        {
          v: 1,
          q: qh,
          done: [...done],
          state: { acc: byCourse ? [] : state.acc, tot: state.tot, pop: state.pop },
        },
        c.deps.cursorSecret,
      );
  if (!complete) {
    c.warnings.push(
      `Partial answer: ${done.size} of ${c.courses.length} ${c.t.vocabulary.coursePlural.toLowerCase()} done. ` +
        "Call query_metrics again with the same arguments and next_cursor.",
    );
  }
  return {
    unit: "enrolments" as const,
    complete,
    progress: { courses_done: done.size, courses_total: c.courses.length },
    next_cursor: next,
    population: complete ? labelledCounts(state.pop, c.t) : undefined,
    totals: complete ? finalize(state.tot, c.signals, c.window !== null, false) : undefined,
    rows_total: rows.length,
    rows: rows.slice(0, c.args.limit).map((r) => finalize(r, c.signals, c.window !== null)),
  };
}

function sanityWarnings(c: RunCtx, selected: EnrolmentRecord[]): void {
  if (
    c.signals.includes("site_last_access") &&
    selected.length >= 20 &&
    selected.every((r) => r.lastSiteAccess === null)
  ) {
    c.warnings.push(
      "No site access dates came back at all: the LMS may be hiding last access from the service account.",
    );
  }
}

function regionNotes(c: RunCtx, observed: Set<string>): void {
  const filterRegions = c.args.filters?.region;
  if (!c.groupBy.includes("region") && !filterRegions?.length) return;
  c.warnings.push(...familyNotes(c.t.dimensions.region.label, [...observed], filterRegions));
}
