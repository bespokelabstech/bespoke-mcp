import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { assertWithinBudget } from "@/core/concurrency";
import { AppError } from "@/core/errors";
import { loadPersonCourses } from "@/domain/enrich";
import { buildEnvelope } from "@/domain/envelope";
import { familyNotes } from "@/domain/people";
import type { EnrolmentRecord } from "@/domain/population";
import {
  loadScope,
  loadScopePage,
  mergedDuplicateAccounts,
  selectPopulation,
  statusCounts,
} from "@/domain/population";
import { resolveCourseScope } from "@/domain/scope";
import { SIGNALS } from "@/domain/signals";
import type { AccessWindow } from "@/domain/time";
import { formatInZone, inWindow, resolveWindow } from "@/domain/time";
import type { Course, LearningDataPort, PersonCourse } from "@/ports/learning";
import type { TenantConfig } from "@/tenants/schema";
import type { ToolDeps } from "./runtime";
import { READ_ONLY_ANNOTATIONS, requireLearning, runTool } from "./runtime";
import {
  filtersField,
  labelledCounts,
  populationField,
  statusLabel,
  toStatuses,
  windowFields,
} from "./shared-schemas";

/**
 * Two ways to list:
 *  - default (sort name / access): loads the whole course once, so it can sort, search, filter by
 *    a signal and report exact totals. Very large courses may not fit one call.
 *  - sort "enrolment_order": pages through the LMS in its own order and stops as soon as the page
 *    is full — fast for any course size, but no totals, search, signal filter or other sort.
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
        `For one ${v.course.toLowerCase()}: the ${people} enrolled (name, ${t.identity.label}, status, ` +
        `${t.dimensions.region.label}, ${t.dimensions.level.label}, ${t.dimensions.branch.label}, last app/site access, last web course access), ` +
        `filterable by profile values, population, a signal (e.g. who has not started) and a name/ID search. ` +
        `Also use it to find a ${v.person.toLowerCase()} by name, or to review legacy/excluded accounts. ` +
        `For very large ${v.coursePlural.toLowerCase()}, use sort "enrolment_order" with next_cursor to browse quickly (no totals).`,
      inputSchema: z.object({
        course_id: z.number().int().positive(),
        filters: filtersField(t),
        population: populationField(t),
        where: z
          .object({
            signal: z.enum(["started", "site_last_access", "web_course_access"]),
            state: z.enum(["yes", "no"]),
          })
          .optional()
          .describe(
            "Keep only people for whom the signal is true (yes) or false (no). For access signals with a window, " +
              "yes = accessed within the window; without a window, yes = ever.",
          ),
        ...windowFields(t),
        search: z
          .string()
          .min(2)
          .max(100)
          .optional()
          .describe(`Case-insensitive match on name or ${t.identity.label}.`),
        include_progress: z
          .boolean()
          .default(false)
          .describe("Adds progress %, completed and started for the listed page."),
        sort: z
          .enum(["name", "site_access_desc", "web_access_desc", "enrolment_order"])
          .default("name")
          .describe(
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
        const ctx: Ctx = { port, t, course: course!, window, statuses: toStatuses(args.population, t), args };
        const warnings: string[] = [];
        if (window?.semantics === "last_access_in_range") warnings.push(window.description);
        if (args.where?.signal === "web_course_access") warnings.push(SIGNALS.web_course_access.caveat!);

        const data =
          args.sort === "enrolment_order" ? await browse(ctx, warnings) : await sortedList(ctx, warnings);
        return buildEnvelope({
          tenant: t,
          environment: deps.env,
          source: port.source,
          nowSec: now,
          courses: [course!],
          filters: args.filters,
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
  statuses: ReturnType<typeof toStatuses>;
  args: {
    filters?: Record<string, string[] | undefined> | undefined;
    where?: { signal: "started" | "site_last_access" | "web_course_access"; state: "yes" | "no" } | undefined;
    search?: string | undefined;
    include_progress: boolean;
    sort: "name" | "site_access_desc" | "web_access_desc" | "enrolment_order";
    limit: number;
    offset: number;
    cursor?: string | undefined;
  };
}

/** Whole-course listing: exact totals, search, signal filter and sorting. */
async function sortedList(c: Ctx, warnings: string[]) {
  const { t, course, args } = c;
  let scope;
  try {
    scope = await loadScope(c.port, t, [course], args.filters ?? {});
  } catch (err) {
    if (err instanceof AppError && (err.code === "scope_too_large" || err.code === "upstream_unavailable")) {
      throw new AppError(
        "scope_too_large",
        `This ${t.vocabulary.course.toLowerCase()} is too large to load in one call. Use sort "enrolment_order" to browse it ` +
          "page by page, or add a region/level/branch filter.",
      );
    }
    throw err;
  }
  const { records, observedRegions } = scope;
  const pop = statusCounts(records, "people");
  let selected = selectPopulation(records, c.statuses);
  if (args.filters?.region?.length) {
    warnings.push(...familyNotes(t.dimensions.region.label, [...observedRegions], args.filters.region));
  }
  const q = args.search?.toLowerCase();
  if (q) {
    selected = selected.filter(
      (r) => r.person.name.toLowerCase().includes(q) || (r.person.identifier ?? "").includes(q),
    );
  }

  let progress: Map<number, Map<number, PersonCourse>> | null = null;
  if (args.where?.signal === "started") {
    const ids = [...new Set(selected.map((r) => r.person.userId))];
    if (ids.length > t.limits.maxPeopleForPersonSignals) {
      throw new AppError(
        "scope_too_large",
        `Filtering by 'started' needs one LMS call per person; ${ids.length} accounts exceed the live limit of ` +
          `${t.limits.maxPeopleForPersonSignals}. Add a region/level/branch filter or a search.`,
      );
    }
    progress = await loadPersonCourses(c.port, t, ids);
  }
  const startedOf = (userId: number): boolean => {
    const pc = progress?.get(userId)?.get(course.id);
    return pc ? pc.completed === true || (pc.progressPct ?? 0) > 0 : false;
  };
  const accessed = (ts: number | null) => (c.window ? inWindow(ts, c.window) : ts !== null);
  if (args.where) {
    const want = args.where.state === "yes";
    const signal = args.where.signal;
    selected = selected.filter((r) => {
      const value =
        signal === "started"
          ? startedOf(r.person.userId)
          : accessed(signal === "site_last_access" ? r.lastSiteAccess : r.lastCourseAccess);
      return value === want;
    });
  }

  selected.sort((a, b) => {
    if (args.sort === "site_access_desc") return (b.lastSiteAccess ?? -1) - (a.lastSiteAccess ?? -1);
    if (args.sort === "web_access_desc") return (b.lastCourseAccess ?? -1) - (a.lastCourseAccess ?? -1);
    return a.person.name.localeCompare(b.person.name);
  });
  const page = selected.slice(args.offset, args.offset + args.limit);
  if (args.include_progress && !progress) {
    progress = await loadPersonCourses(
      c.port,
      t,
      page.map((r) => r.person.userId),
    );
  }
  return {
    population: labelledCounts(pop, t, mergedDuplicateAccounts(records)),
    matched_accounts: selected.length,
    matched_people: new Set(selected.map((r) => r.person.key)).size,
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
      'sort "enrolment_order" cannot be combined with search or where; use the default sort for those.',
    );
  }
  let [off, skip] = (args.cursor ?? "0:0").split(":").map(Number) as [number, number];
  const pageSize = t.limits.participantsPageSize;
  if (off % pageSize !== 0) throw new AppError("invalid_input", "Invalid cursor for this course listing.");
  const out: EnrolmentRecord[] = [];
  let next: string | null = null;
  for (;;) {
    let page;
    try {
      assertWithinBudget();
      page = await loadScopePage(c.port, t, course, off, args.filters ?? {});
    } catch (err) {
      const outOfTime =
        err instanceof AppError && (err.code === "scope_too_large" || err.code === "upstream_unavailable");
      if (outOfTime && out.length > 0) {
        next = `${off}:${skip}`;
        break;
      }
      throw err;
    }
    const matches = selectPopulation(page.records, c.statuses).slice(skip);
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
  warnings.push(
    "Browsing in enrolment order: totals are not computed. Use the default sort for population and matched counts.",
  );
  return { next_cursor: next, people: out.map((r) => row(c, r, progress)) };
}

function row(c: Ctx, r: EnrolmentRecord, progress: Map<number, Map<number, PersonCourse>> | null) {
  const { t, course } = c;
  const pc = progress?.get(r.person.userId)?.get(course.id);
  return {
    name: r.person.name,
    identifier: r.person.identifier ?? t.emptyValueLabel,
    ...(r.person.identifierNormalised ? { identifier_repaired: true } : {}),
    status: statusLabel(r.person.status, t),
    ...(r.person.reason ? { excluded_reason: r.person.reason } : {}),
    region: r.person.region,
    level: r.person.level,
    branch: r.person.branch.label,
    branch_name: r.person.branch.name ?? t.emptyValueLabel,
    branch_code: r.person.branch.code ?? t.emptyValueLabel,
    site_last_access: formatInZone(r.lastSiteAccess, t.timezone),
    web_course_access: formatInZone(r.lastCourseAccess, t.timezone),
    ...(progress
      ? {
          started: pc ? pc.completed === true || (pc.progressPct ?? 0) > 0 : null,
          progress_pct: pc?.progressPct ?? null,
          completed: pc?.completed ?? null,
        }
      : {}),
  };
}
