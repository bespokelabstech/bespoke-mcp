import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { loadScope } from "@/domain/access";
import { buildEnvelope } from "@/domain/envelope";
import { dimensionValue } from "@/domain/people";
import { resolveCourseScope } from "@/domain/scope";
import type { ToolDeps } from "./runtime";
import { READ_ONLY_ANNOTATIONS, requireLearning, runTool } from "./runtime";
import { dimensionEnum, filtersField, scopeFields } from "./shared-schemas";

export function registerGetDimensions(server: McpServer, deps: ToolDeps): void {
  const t = deps.tenant;
  const v = t.vocabulary;
  const d = t.dimensions;
  server.registerTool(
    "get_dimensions",
    {
      title: `${d.region.label}s, ${d.level.label}s and ${d.branch.label}es`,
      description:
        `List the values of a business dimension — region (${d.region.label}), level (${d.level.label}) or ` +
        `branch (${d.branch.label}) — exactly as stored in ${v.person.toLowerCase()} profiles, with the number of ` +
        `enrolled ${v.personPlural.toLowerCase()} for each. Call this before filtering so you use real values.`,
      inputSchema: z.object({
        dimension: dimensionEnum,
        ...scopeFields(t),
        filters: filtersField(t),
        limit: z.number().int().min(1).max(1000).default(200),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) =>
      runTool("get_dimensions", deps, args, async () => {
        const port = requireLearning(deps);
        const courses = await resolveCourseScope(port, t, args);
        const filters = args.filters ?? {};
        const { records } = await loadScope(port, t, courses, filters);
        const people = new Map(records.map((r) => [r.person.userId, r.person]));
        const counts = new Map<
          string,
          { value: string; name: string | null; code: string | null; people: number }
        >();
        for (const p of people.values()) {
          const value = dimensionValue(p, args.dimension);
          const entry = counts.get(value) ?? {
            value,
            name: args.dimension === "branch" ? p.branch.name : null,
            code: args.dimension === "branch" ? p.branch.code : null,
            people: 0,
          };
          entry.people++;
          counts.set(value, entry);
        }
        const values = [...counts.values()].sort(
          (a, b) => b.people - a.people || a.value.localeCompare(b.value),
        );
        return buildEnvelope({
          tenant: t,
          environment: deps.env,
          source: port.source,
          nowSec: deps.nowSec(),
          courses,
          filters,
          data: {
            dimension: args.dimension,
            label: d[args.dimension].label,
            total_people: people.size,
            distinct_values: values.length,
            values: values.slice(0, args.limit).map((x) =>
              args.dimension === "branch"
                ? {
                    value: x.value,
                    branch_name: x.name ?? t.emptyValueLabel,
                    branch_code: x.code ?? t.emptyValueLabel,
                    people: x.people,
                  }
                : { value: x.value, people: x.people },
            ),
          },
        });
      }),
  );
}
