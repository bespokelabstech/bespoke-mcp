import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AppError } from "@/core/errors";
import { loadCompletion, loadScope, pct } from "@/domain/access";
import { buildEnvelope } from "@/domain/envelope";
import { resolveCourseScope } from "@/domain/scope";
import { formatInZone, inWindow, resolveWindow } from "@/domain/time";
import type { ToolDeps } from "./runtime";
import { READ_ONLY_ANNOTATIONS, requireLearning, runTool } from "./runtime";
import { filtersField, windowFields } from "./shared-schemas";

export function registerGetCourseAccess(server: McpServer, deps: ToolDeps): void {
  const t = deps.tenant;
  const v = t.vocabulary;
  const people = v.personPlural.toLowerCase();
  server.registerTool(
    "get_course_access",
    {
      title: `${v.course} access`,
      description:
        `For one ${v.course.toLowerCase()}: totals of enrolled / accessed / never accessed ${people}, plus the list of ` +
        `${people} (name, ${t.identity.label}, ${t.dimensions.region.label}, ${t.dimensions.level.label}, ` +
        `${t.dimensions.branch.label}, last access). Filter by status, profile values or a name/ID search. ` +
        `Also use it to find a ${v.person.toLowerCase()} by name.`,
      inputSchema: z.object({
        course_id: z.number().int().positive(),
        filters: filtersField(t),
        status: z
          .enum(["all", "accessed", "never_accessed", "accessed_in_window", "not_accessed_in_window"])
          .default("all"),
        search: z
          .string()
          .min(2)
          .max(100)
          .optional()
          .describe(`Case-insensitive match on name or ${t.identity.label}.`),
        ...windowFields(t),
        include_completion: z
          .boolean()
          .default(false)
          .describe("Adds progress % and completed for the people on this page."),
        sort: z.enum(["last_access_desc", "last_access_asc", "name"]).default("last_access_desc"),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) =>
      runTool("get_course_access", deps, args, async () => {
        const port = requireLearning(deps);
        const now = deps.nowSec();
        const window = resolveWindow(args, t.timezone, now);
        if (args.status.includes("window") && !window) {
          throw new AppError(
            "invalid_input",
            "status accessed_in_window / not_accessed_in_window needs recent_days or since.",
          );
        }
        const [course] = await resolveCourseScope(port, t, { course_ids: [args.course_id] });
        const { records } = await loadScope(port, t, [course!], args.filters ?? {});

        const enrolled = records.length;
        const accessed = records.filter((r) => r.lastCourseAccess !== null).length;
        const inWin = window ? records.filter((r) => inWindow(r.lastCourseAccess, window)).length : undefined;

        const q = args.search?.toLowerCase();
        const selected = records
          .filter((r) => {
            switch (args.status) {
              case "accessed":
                return r.lastCourseAccess !== null;
              case "never_accessed":
                return r.lastCourseAccess === null;
              case "accessed_in_window":
                return inWindow(r.lastCourseAccess, window!);
              case "not_accessed_in_window":
                return !inWindow(r.lastCourseAccess, window!);
              default:
                return true;
            }
          })
          .filter(
            (r) => !q || r.person.name.toLowerCase().includes(q) || (r.person.identifier ?? "").includes(q),
          )
          .sort((a, b) => {
            if (args.sort === "name") return a.person.name.localeCompare(b.person.name);
            const av = a.lastCourseAccess ?? -1;
            const bv = b.lastCourseAccess ?? -1;
            return args.sort === "last_access_asc" ? av - bv : bv - av;
          });
        const page = selected.slice(args.offset, args.offset + args.limit);

        const completion = args.include_completion
          ? await loadCompletion(
              port,
              t,
              page.map((r) => r.person.userId),
            )
          : null;

        const warnings = window?.semantics === "last_access_in_range" ? [window.description] : [];
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
            totals: {
              enrolled,
              accessed,
              never_accessed: enrolled - accessed,
              access_rate_pct: pct(accessed, enrolled),
              ...(window ? { accessed_in_window: inWin, window_rate_pct: pct(inWin!, enrolled) } : {}),
            },
            identifier_label: t.identity.label,
            matched: selected.length,
            next_offset: args.offset + page.length < selected.length ? args.offset + page.length : null,
            people: page.map((r) => {
              const pc = completion?.get(r.person.userId)?.get(course!.id);
              return {
                name: r.person.name,
                identifier: r.person.identifier ?? t.emptyValueLabel,
                region: r.person.region,
                level: r.person.level,
                branch: r.person.branch.label,
                branch_name: r.person.branch.name ?? t.emptyValueLabel,
                branch_code: r.person.branch.code ?? t.emptyValueLabel,
                last_access: formatInZone(r.lastCourseAccess, t.timezone),
                accessed: r.lastCourseAccess !== null,
                ...(completion
                  ? { progress_pct: pc?.progressPct ?? null, completed: pc?.completed ?? null }
                  : {}),
              };
            }),
          },
        });
      }),
  );
}
