import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { assertWithinBudget } from "@/core/concurrency";
import { AppError, isOutOfTime } from "@/core/errors";
import { loadPersonCourses } from "@/domain/enrich";
import { buildEnvelope } from "@/domain/envelope";
import { compareValues, isAccessed, parseSort } from "@/domain/metrics";
import type { Filters } from "@/domain/people";
import { familyNotes } from "@/domain/people";
import type { EnrolmentRecord } from "@/domain/population";
import { loadScope, loadScopePage, populationCounts, selectPopulation } from "@/domain/population";
import { resolveCourseScope } from "@/domain/scope";
import { SIGNALS } from "@/domain/signals";
import type { AccessWindow } from "@/domain/time";
import { formatInZone, inWindow, resolveWindow } from "@/domain/time";
import type { Course, LearningDataPort, PersonCourse } from "@/ports/learning";
import type { TenantConfig } from "@/tenants/schema";
import { regionSourceNote } from "./notes";
import type { ToolDeps } from "./runtime";
import { READ_ONLY_ANNOTATIONS, requireLearning, runTool } from "./runtime";
import {
  excludeField,
  filtersField,
  populationOut,
  resolveFilters,
  validOnlyField,
  windowFields,
} from "./shared-schemas";

/** Sortable columns. progress / accessed need one LMS call per account (capped). */
const SORT_KEYS = [
  "name",
  "conso_id",
  "region",
  "branch",
  "level",
  "last_sign_in",
  "web_course_access",
  "progress",
  "accessed",
] as const;
type SortKey = (typeof SORT_KEYS)[number];
const SORT_VALUES = ["enrolment_order", ...SORT_KEYS.flatMap((k) => [k, `-${k}`])] as [string, ...string[]];
const PER_PERSON_SORT: SortKey[] = ["progress", "accessed"];

type WhereSignal = "accessed" | "logged_in" | "web_course_access";

/**
 * Two ways to list:
 *  - sorted (default sort name): loads the whole course once, so it can sort on any column,
 *    search, filter by a metric and report exact totals. Very large courses may not fit one call.
 *  - sort "enrolment_order": pages through the LMS in its own order and stops as soon as the page
 *    is full — fast for any course size, but no totals, search, metric filter or other sort.
 */
export function registerListPeople(server: McpServer, deps: ToolDeps): void {
  const t = deps.tenant;
  const v = t.vocabulary;
  const people = v.personPlural.toLowerCase();
  server.registerTool(
    "list_people",
    {
      title: `${v.personPlural} in a ${v.course}`,
      description:
        `For one ${v.course.toLowerCase()}: the ${people} enrolled (name, username, ${t.identity.label}, valid or not, ` +
        `${t.dimensions.region.label}, ${t.dimensions.level.label}, ${t.dimensions.branch.label}, last sign-in, last web course access), ` +
        `with the same filters and defaults as query_metrics, a metric filter (e.g. who has not accessed), a name/ID search ` +
        `and sorting on any column (e.g. sort "-last_sign_in"). Also use it to find a ${v.person.toLowerCase()} by name, or ` +
        `with valid_only=false to review accounts that fail the saved filter. For very large ${v.coursePlural.toLowerCase()}, ` +
        `use sort "enrolment_order" with next_cursor to browse quickly (no totals).`,
      inputSchema: z.strictObject({
        course_id: z.number().int().positive(),
        filters: filtersField(t),
        exclude: excludeField(t),
        valid_only: validOnlyField(t),
        where: z
          .object({
            signal: z.enum(["accessed", "logged_in", "web_course_access"]),
            state: z.enum(["yes", "no"]),
          })
          .optional()
          .describe(
            "Keep only accounts for whom the metric is true (yes) or false (no). For logged_in/web_course_access with a date " +
              "range, yes = inside the range; without one, yes = ever. accessed is all-time.",
          ),
        ...windowFields(t),
        search: z
          .string()
          .min(2)
          .max(100)
          .optional()
          .describe(`Case-insensitive match on name, username or ${t.identity.label}.`),
        include_progress: z
          .boolean()
          .default(false)
          .describe("Adds accessed, progress % and completed for the listed page."),
        sort: z
          .enum(SORT_VALUES)
          .default("name")
          .describe(
            "Column to sort on; prefix '-' for descending (e.g. -last_sign_in). progress/accessed need one LMS call per " +
              `account and work up to ${t.limits.maxPeopleForPersonSignals} matching accounts. ` +
              "enrolment_order = fast browsing in the LMS's own order for any course size (use next_cursor; no totals, search or where).",
          ),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0).describe("For the sorted modes."),
        cursor: z
          .string()
          .regex(/^\d+:\d+$/)
          .optional()
          .describe("For sort enrolment_order: next_cursor from the previous page."),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) =>
      runTool("list_people", deps, args, async () => {
        const port = requireLearning(deps);
        const now = deps.nowSec();
        const window = resolveWindow(args, t.timezone, now);
        const [course] = await resolveCourseScope(port, t, { course_ids: [args.course_id] });
        const resolved = resolveFilters(args, t);
        const ctx: Ctx = {
          port,
          t,
          course: course!,
          window,
          filters: resolved.filters,
          validOnly: resolved.validOnly,
          args,
        };
        const warnings: string[] = [];
        if (window?.semantics === "last_access_in_range") warnings.push(window.description);
        if (args.where?.signal === "web_course_access") warnings.push(SIGNALS.web_course_access.caveat!);
        if (args.where?.signal === "accessed" && window) warnings.push(SIGNALS.accessed.caveat!);
        if (resolved.filters.include.region?.length || resolved.filters.exclude.region?.length) {
          warnings.push(regionSourceNote(t));
        }

        const data =
          args.sort === "enrolment_order" ? await browse(ctx, warnings) : await sortedList(ctx, warnings);
        return buildEnvelope({
          tenant: t,
          environment: deps.env,
          source: port.source,
          nowSec: now,
          courses: [course!],
          filters: resolved.applied,
          window,
          warnings,
          data: {
            course: { id: course!.id, name: course!.fullName, completion_tracked: course!.completionEnabled },
            identifier_label: t.identity.label,
            ...data,
          },
        });
      }),
  );
}

interface Ctx {
  port: LearningDataPort;
  t: TenantConfig;
  course: Course;
  window: AccessWindow | null;
  filters: Filters;
  validOnly: boolean;
  args: {
    where?: { signal: WhereSignal; state: "yes" | "no" } | undefined;
    search?: string | undefined;
    include_progress: boolean;
    sort: string;
    limit: number;
    offset: number;
    cursor?: string | undefined;
  };
}

type Progress = Map<number, Map<number, PersonCourse>>;

/** Whole-course listing: exact totals, search, metric filter and sorting on any column. */
async function sortedList(c: Ctx, warnings: string[]) {
  const { t, course, args } = c;
  if (args.cursor) {
    throw new AppError(
      "invalid_input",
      'cursor is only for sort "enrolment_order"; use offset with this sort.',
    );
  }
  let scope;
  try {
    scope = await loadScope(c.port, t, [course], c.filters);
  } catch (err) {
    // Only a time-budget overrun means "too large"; a genuine LMS outage passes through unchanged.
    if (err instanceof AppError && err.code === "scope_too_large") {
      throw new AppError(
        "scope_too_large",
        `This ${t.vocabulary.course.toLowerCase()} is too large to load in one call. Use sort "enrolment_order" to browse it ` +
          "page by page, or add a region/level/branch filter.",
      );
    }
    throw err;
  }
  const { records, observedRegions } = scope;
  const pop = populationCounts(records, "accounts");
  let selected = selectPopulation(records, c.validOnly);
  if (c.filters.include.region?.length) {
    warnings.push(...familyNotes(t.dimensions.region.label, [...observedRegions], c.filters.include.region));
  }
  const q = args.search?.toLowerCase();
  if (q) {
    selected = selected.filter(
      (r) =>
        r.person.name.toLowerCase().includes(q) ||
        r.person.username.toLowerCase().includes(q) ||
        (r.person.identifier ?? "").toLowerCase().includes(q),
    );
  }

  const { key, desc } = parseSort<SortKey>(args.sort);
  let progress: Progress | null = null;
  const needsAll = args.where?.signal === "accessed" || PER_PERSON_SORT.includes(key);
  if (needsAll) {
    const ids = [...new Set(selected.map((r) => r.person.userId))];
    if (ids.length > t.limits.maxPeopleForPersonSignals) {
      const what = args.where?.signal === "accessed" ? "Filtering by accessed" : `Sorting by ${key}`;
      throw new AppError(
        "scope_too_large",
        `${what} needs one LMS call per account; ${ids.length} accounts exceed the live limit of ` +
          `${t.limits.maxPeopleForPersonSignals}. Add a region/level/branch filter or a search, ` +
          "or sort by name, conso_id, region, branch, level or last_sign_in.",
      );
    }
    progress = await loadPersonCourses(c.port, t, ids);
  }
  const pcOf = (userId: number) => progress?.get(userId)?.get(course.id) ?? null;
  const inRange = (ts: number | null) => (c.window ? inWindow(ts, c.window) : ts !== null);
  if (args.where) {
    const want = args.where.state === "yes";
    const signal = args.where.signal;
    selected = selected.filter((r) => {
      const pc = pcOf(r.person.userId);
      const value =
        signal === "accessed"
          ? pc !== null && isAccessed(pc)
          : inRange(signal === "logged_in" ? r.lastSiteAccess : r.lastCourseAccess);
      return value === want;
    });
  }

  const sortValue = (r: EnrolmentRecord): number | string | null => {
    switch (key) {
      case "name":
        return r.person.name.toLowerCase();
      case "conso_id":
        return r.person.identifier?.toLowerCase() ?? null;
      case "region":
        return r.person.region.toLowerCase();
      case "branch":
        return r.person.branch.label.toLowerCase();
      case "level":
        return r.person.level.toLowerCase();
      case "last_sign_in":
        return r.lastSiteAccess;
      case "web_course_access":
        return r.lastCourseAccess;
      case "progress":
        return pcOf(r.person.userId)?.progressPct ?? null;
      case "accessed": {
        const pc = pcOf(r.person.userId);
        return pc ? Number(isAccessed(pc)) : null;
      }
    }
  };
  selected.sort(
    (a, b) =>
      compareValues(sortValue(a), sortValue(b), desc) ||
      a.person.name.localeCompare(b.person.name) ||
      a.person.userId - b.person.userId,
  );
  const page = selected.slice(args.offset, args.offset + args.limit);
  if (args.include_progress && !progress) {
    progress = await loadPersonCourses(
      c.port,
      t,
      page.map((r) => r.person.userId),
    );
  }
  return {
    population: populationOut(pop, t, c.validOnly),
    matched: selected.length,
    sort: args.sort,
    next_offset: args.offset + page.length < selected.length ? args.offset + page.length : null,
    people: page.map((r) => row(c, r, progress)),
  };
}

/**
 * Fast browsing in the LMS's enrolment order. The cursor is "<lms offset>:<matches to skip in
 * that page>"; each call reads only as many pages as needed to fill `limit`.
 */
async function browse(c: Ctx, warnings: string[]) {
  const { t, course, args } = c;
  if (args.search || args.where) {
    throw new AppError(
      "invalid_input",
      'sort "enrolment_order" cannot be combined with search or where; use another sort for those.',
    );
  }
  if (args.offset > 0) {
    throw new AppError(
      "invalid_input",
      'sort "enrolment_order" pages with cursor (next_cursor), not offset.',
    );
  }
  let [off, skip] = (args.cursor ?? "0:0").split(":").map(Number) as [number, number];
  const pageSize = t.limits.participantsPageSize;
  if (off % pageSize !== 0) throw new AppError("invalid_input", "Invalid cursor for this course listing.");
  const out: EnrolmentRecord[] = [];
  const observed = new Set<string>();
  let next: string | null = null;
  let scanned = 0;
  for (;;) {
    let page;
    try {
      assertWithinBudget();
      page = await loadScopePage(c.port, t, course, off, c.filters);
    } catch (err) {
      // Out of time after reading at least one page: hand back what we have (possibly nothing,
      // when matches are rare) and a cursor at the page we reached, so the caller can continue.
      if (isOutOfTime(err) && scanned > 0) {
        next = `${off}:${skip}`;
        break;
      }
      throw err;
    }
    scanned++;
    page.observedRegions.forEach((r) => observed.add(r));
    const matches = selectPopulation(page.records, c.validOnly).slice(skip);
    const take = matches.slice(0, args.limit - out.length);
    out.push(...take);
    if (take.length < matches.length) {
      next = `${off}:${skip + take.length}`; // page has more matches than fit
      break;
    }
    if (page.done) break; // course finished
    off += pageSize;
    skip = 0;
    if (out.length >= args.limit) {
      next = `${off}:0`;
      break;
    }
  }
  const progress = args.include_progress
    ? await loadPersonCourses(
        c.port,
        t,
        out.map((r) => r.person.userId),
      )
    : null;
  if (c.filters.include.region?.length) {
    warnings.push(...familyNotes(t.dimensions.region.label, [...observed], c.filters.include.region));
  }
  if (next && out.length === 0) {
    warnings.push(
      "No matches in the part of the course read so far; call again with next_cursor to keep looking.",
    );
  }
  warnings.push(
    "Browsing in enrolment order: totals are not computed (use another sort for population and matched counts). " +
      "Best effort: if enrolments change while browsing, someone may repeat or be skipped.",
  );
  return { next_cursor: next, people: out.map((r) => row(c, r, progress)) };
}

function row(c: Ctx, r: EnrolmentRecord, progress: Progress | null) {
  const { t, course } = c;
  const pc = progress?.get(r.person.userId)?.get(course.id);
  return {
    name: r.person.name,
    username: r.person.username,
    conso_id: r.person.identifier ?? t.emptyValueLabel,
    valid: r.person.valid,
    ...(r.person.failed.length ? { not_valid_because: r.person.failed } : {}),
    region: r.person.region,
    level: r.person.level,
    branch: r.person.branch.label,
    branch_name: r.person.branch.name ?? t.emptyValueLabel,
    branch_code: r.person.branch.code ?? t.emptyValueLabel,
    last_sign_in: formatInZone(r.lastSiteAccess, t.timezone),
    web_course_access: formatInZone(r.lastCourseAccess, t.timezone),
    ...(progress
      ? {
          accessed: pc ? isAccessed(pc) : null,
          progress_pct: pc?.progressPct ?? null,
          completed: pc?.completed ?? null,
        }
      : {}),
  };
}
