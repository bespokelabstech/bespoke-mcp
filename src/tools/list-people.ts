import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AppError } from "@/core/errors";
import { loadPersonCourses } from "@/domain/enrich";
import { buildEnvelope } from "@/domain/envelope";
import { familyNotes } from "@/domain/people";
import { loadScope, selectPopulation, statusCounts } from "@/domain/population";
import { resolveCourseScope } from "@/domain/scope";
import { SIGNALS } from "@/domain/signals";
import { formatInZone, inWindow, resolveWindow } from "@/domain/time";
import type { PersonCourse } from "@/ports/learning";
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
        `Also use it to find a ${v.person.toLowerCase()} by name, or to review legacy/excluded accounts.`,
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
        sort: z.enum(["name", "site_access_desc", "web_access_desc"]).default("name"),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) =>
      runTool("list_people", deps, args, async () => {
        const port = requireLearning(deps);
        const now = deps.nowSec();
        const window = resolveWindow(args, t.timezone, now);
        const [course] = await resolveCourseScope(port, t, { course_ids: [args.course_id] });
        const { records, observedRegions } = await loadScope(port, t, [course!], args.filters ?? {});
        const pop = statusCounts(records, "people");
        let selected = selectPopulation(records, toStatuses(args.population, t));
        const warnings: string[] = [];
        if (window?.semantics === "last_access_in_range") warnings.push(window.description);
        if (args.where?.signal === "web_course_access") warnings.push(SIGNALS.web_course_access.caveat!);
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
          progress = await loadPersonCourses(port, t, ids);
        }
        const startedOf = (userId: number): boolean | null => {
          const pc = progress?.get(userId)?.get(course!.id);
          return pc ? pc.completed === true || (pc.progressPct ?? 0) > 0 : null;
        };
        const accessed = (ts: number | null) => (window ? inWindow(ts, window) : ts !== null);
        if (args.where) {
          const want = args.where.state === "yes";
          selected = selected.filter((r) => {
            const value =
              args.where!.signal === "started"
                ? startedOf(r.person.userId) === true
                : accessed(args.where!.signal === "site_last_access" ? r.lastSiteAccess : r.lastCourseAccess);
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
            port,
            t,
            page.map((r) => r.person.userId),
          );
        }

        const distinct = new Set(selected.map((r) => r.person.key)).size;
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
            population: labelledCounts(pop, t),
            identifier_label: t.identity.label,
            matched_accounts: selected.length,
            matched_people: distinct,
            next_offset: args.offset + page.length < selected.length ? args.offset + page.length : null,
            people: page.map((r) => {
              const pc = progress?.get(r.person.userId)?.get(course!.id);
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
            }),
          },
        });
      }),
  );
}
