import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { buildEnvelope } from "@/domain/envelope";
import { dimensionValue, familyNotes } from "@/domain/people";
import { loadScope, selectPopulation, statusCounts } from "@/domain/population";
import { resolveCourseScope } from "@/domain/scope";
import type { ToolDeps } from "./runtime";
import { READ_ONLY_ANNOTATIONS, requireLearning, runTool } from "./runtime";
import {
  dimensionEnum,
  filtersField,
  labelledCounts,
  populationField,
  scopeFields,
  toStatuses,
} from "./shared-schemas";

export function registerListDimensionValues(server: McpServer, deps: ToolDeps): void {
  const t = deps.tenant;
  const v = t.vocabulary;
  const d = t.dimensions;
  server.registerTool(
    "list_dimension_values",
    {
      title: `${d.region.label}, ${d.level.label} and ${d.branch.label} values`,
      description:
        `List the values of a dimension — region (${d.region.label}), level (${d.level.label}) or branch (${d.branch.label}) — ` +
        `exactly as stored in ${v.person.toLowerCase()} profiles (the system is the source of truth), with the number of ` +
        `${v.personPlural.toLowerCase()} for each. Call it before filtering so real values are used; for large scopes pass course_ids.`,
      inputSchema: z.object({
        dimension: dimensionEnum,
        ...scopeFields(t),
        filters: filtersField(t),
        population: populationField(t),
        limit: z.number().int().min(1).max(1000).default(200),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) =>
      runTool("list_dimension_values", deps, args, async () => {
        const port = requireLearning(deps);
        const courses = await resolveCourseScope(port, t, args);
        const { records } = await loadScope(port, t, courses, args.filters ?? {});
        const pop = statusCounts(records, "people");
        const selected = selectPopulation(records, toStatuses(args.population, t));
        const people = new Map(selected.map((r) => [r.person.key, r.person]));
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
          filters: args.filters,
          warnings: familyNotes(
            d[args.dimension].label,
            values.map((x) => x.value),
          ),
          data: {
            dimension: args.dimension,
            label: d[args.dimension].label,
            population: labelledCounts(pop, t),
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
