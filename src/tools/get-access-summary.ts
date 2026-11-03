import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { GroupDim } from "@/domain/access";
import { distinctPeople, loadCompletion, loadScope, summarize } from "@/domain/access";
import { buildEnvelope } from "@/domain/envelope";
import { resolveCourseScope } from "@/domain/scope";
import { resolveWindow } from "@/domain/time";
import type { ToolDeps } from "./runtime";
import { READ_ONLY_ANNOTATIONS, requireLearning, runTool } from "./runtime";
import { filtersField, scopeFields, windowFields } from "./shared-schemas";

export function registerGetAccessSummary(server: McpServer, deps: ToolDeps): void {
  const t = deps.tenant;
  const v = t.vocabulary;
  const people = v.personPlural.toLowerCase();
  server.registerTool(
    "get_access_summary",
    {
      title: `${v.person} access summary`,
      description:
        `Count enrolled ${people}, how many have accessed vs never accessed, and (optionally) how many accessed ` +
        `in a time window — grouped by region, level, branch and/or ${v.course.toLowerCase()}. ` +
        `Use for charts like "access per ${t.dimensions.region.label}" or "access per ${v.course}". ` +
        `Set include_completion for completion rates (only for scopes up to ${t.limits.maxPeopleForCompletion} ${people}). ` +
        `Report numbers exactly as returned; do not recompute them.`,
      inputSchema: z.object({
        ...scopeFields(t),
        filters: filtersField(t),
        group_by: z
          .array(z.enum(["region", "level", "branch", "course"]))
          .min(1)
          .max(2)
          .default(["region"])
          .describe("One or two dimensions to group by."),
        count_by: z
          .enum(["people", "enrolments"])
          .default("people")
          .describe(
            `people = each ${v.person.toLowerCase()} once per group (accessed = accessed any ${v.course.toLowerCase()} in scope); ` +
              `enrolments = each ${v.person.toLowerCase()}-${v.course.toLowerCase()} pair. Grouping by course always counts enrolments.`,
          ),
        ...windowFields(t),
        include_completion: z.boolean().default(false),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(50)
          .describe("Max rows returned (largest groups first)."),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) =>
      runTool("get_access_summary", deps, args, async () => {
        const port = requireLearning(deps);
        const now = deps.nowSec();
        const window = resolveWindow(args, t.timezone, now);
        const courses = await resolveCourseScope(port, t, args);
        const filters = args.filters ?? {};
        const { records, excluded } = await loadScope(port, t, courses, filters);
        const warnings: string[] = [];

        let completion = null;
        if (args.include_completion) {
          const ids = distinctPeople(records);
          if (ids.length > t.limits.maxPeopleForCompletion) {
            warnings.push(
              `Completion skipped: ${ids.length} ${people} in scope exceeds the live limit of ${t.limits.maxPeopleForCompletion}. ` +
                "Narrow by region, level, branch or course.",
            );
          } else {
            completion = await loadCompletion(port, t, ids);
          }
        }
        if (window?.semantics === "last_access_in_range") warnings.push(window.description);

        const groupBy = args.group_by as GroupDim[];
        const rows = summarize(records, { groupBy, countBy: args.count_by, window, completion });
        const totalsPeople = summarize(records, { groupBy: [], countBy: "people", window, completion })[0];
        const totalsEnrol = summarize(records, { groupBy: [], countBy: "enrolments", window, completion })[0];
        if (completion && totalsEnrol?.completion?.tracked_enrolments === 0) {
          warnings.push(
            "No completion data visible: completion may be untracked in these courses or not readable by the service account.",
          );
        }

        return buildEnvelope({
          tenant: t,
          environment: deps.env,
          source: port.source,
          nowSec: now,
          courses,
          filters,
          window,
          warnings,
          data: {
            unit: groupBy.includes("course") ? "enrolments" : args.count_by,
            totals: {
              people: totalsPeople ? omitGroup(totalsPeople) : null,
              enrolments: totalsEnrol ? omitGroup(totalsEnrol) : null,
            },
            rows_total: rows.length,
            rows: rows.slice(0, args.limit),
            excluded_users: excluded,
          },
        });
      }),
  );
}

function omitGroup<T extends { group: unknown }>(row: T): Omit<T, "group"> {
  const { group: _group, ...rest } = row;
  return rest;
}
