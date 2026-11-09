import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { buildEnvelope } from "@/domain/envelope";
import { dimensionValue, familyNotes } from "@/domain/people";
import { loadScope, populationCounts, selectPopulation } from "@/domain/population";
import { resolveCourseScope } from "@/domain/scope";
import type { PersonView } from "@/domain/people";
import { dataWarnings, regionSourceNote } from "./notes";
import type { ToolDeps } from "./runtime";
import { READ_ONLY_ANNOTATIONS, requireLearning, runTool } from "./runtime";
import {
  excludeField,
  filtersField,
  populationOut,
  resolveFilters,
  scopeFields,
  validOnlyField,
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
        `accounts for each (valid dealers only by default, so values only hidden accounts have — e.g. PC Center of Excellence — ` +
        `do not show unless valid_only=false). Call it before filtering so real values are used; for large scopes pass course_ids.`,
      inputSchema: z.strictObject({
        dimension: z.enum(["region", "level", "branch"]),
        ...scopeFields(t),
        filters: filtersField(t),
        exclude: excludeField(t),
        valid_only: validOnlyField(t),
        limit: z.number().int().min(1).max(1000).default(200),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) =>
      runTool("list_dimension_values", deps, args, async () => {
        const port = requireLearning(deps);
        const courses = await resolveCourseScope(port, t, args);
        const resolved = resolveFilters(args, t);
        const { records } = await loadScope(port, t, courses, resolved.filters);
        const pop = populationCounts(records, "accounts");
        const selected = selectPopulation(records, resolved.validOnly);
        const people = new Map<number, PersonView>(selected.map((r) => [r.person.userId, r.person]));
        const counts = new Map<
          string,
          { value: string; name: string | null; code: string | null; accounts: number }
        >();
        for (const p of people.values()) {
          const value = dimensionValue(p, args.dimension);
          const entry = counts.get(value) ?? {
            value,
            name: args.dimension === "branch" ? p.branch.name : null,
            code: args.dimension === "branch" ? p.branch.code : null,
            accounts: 0,
          };
          entry.accounts++;
          counts.set(value, entry);
        }
        const values = [...counts.values()].sort(
          (a, b) => b.accounts - a.accounts || a.value.localeCompare(b.value),
        );
        return buildEnvelope({
          tenant: t,
          environment: deps.env,
          source: port.source,
          nowSec: deps.nowSec(),
          courses,
          filters: resolved.applied,
          warnings: [
            ...(args.dimension === "region" ? [regionSourceNote(t)] : []),
            ...dataWarnings(
              t,
              selected.map((r) => r.person),
            ),
            ...familyNotes(
              d[args.dimension].label,
              values.map((x) => x.value),
            ),
          ],
          data: {
            dimension: args.dimension,
            label: d[args.dimension].label,
            population: populationOut(pop, t, resolved.validOnly),
            total_accounts: people.size,
            distinct_values: values.length,
            values: values.slice(0, args.limit).map((x) =>
              args.dimension === "branch"
                ? {
                    value: x.value,
                    branch_name: x.name ?? t.emptyValueLabel,
                    branch_code: x.code ?? t.emptyValueLabel,
                    accounts: x.accounts,
                  }
                : { value: x.value, accounts: x.accounts },
            ),
          },
        });
      }),
  );
}
