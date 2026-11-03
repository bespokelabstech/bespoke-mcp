import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { buildEnvelope } from "@/domain/envelope";
import { tenantCourses } from "@/domain/scope";
import { formatInZone } from "@/domain/time";
import type { ToolDeps } from "./runtime";
import { READ_ONLY_ANNOTATIONS, requireLearning, runTool } from "./runtime";

export function registerListCourses(server: McpServer, deps: ToolDeps): void {
  const v = deps.tenant.vocabulary;
  server.registerTool(
    "list_courses",
    {
      title: `List ${v.coursePlural}`,
      description:
        `List the ${v.coursePlural.toLowerCase()} in scope with ids, names, category and whether completion is tracked. ` +
        `Use it to resolve ${v.course.toLowerCase()} names to ids before calling other tools.`,
      inputSchema: z.object({
        search: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe("Case-insensitive match on name or short name."),
        category_ids: z.array(z.number().int().positive()).max(50).optional(),
        limit: z.number().int().min(1).max(200).default(100),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) =>
      runTool("list_courses", deps, args, async () => {
        const port = requireLearning(deps);
        const tz = deps.tenant.timezone;
        const [courses, categories] = await Promise.all([
          tenantCourses(port, deps.tenant),
          port.listCategories(),
        ]);
        const cats = new Map(categories.map((c) => [c.id, c]));
        const q = args.search?.toLowerCase();
        const filtered = courses
          .filter((c) => !q || c.fullName.toLowerCase().includes(q) || c.shortName.toLowerCase().includes(q))
          .filter((c) => {
            if (!args.category_ids?.length) return true;
            const path = cats.get(c.categoryId)?.pathIds ?? [c.categoryId];
            return args.category_ids.some((id) => path.includes(id));
          })
          .sort((a, b) => a.fullName.localeCompare(b.fullName));
        const page = filtered.slice(args.offset, args.offset + args.limit);
        return buildEnvelope({
          tenant: deps.tenant,
          environment: deps.env,
          source: port.source,
          nowSec: deps.nowSec(),
          data: {
            total: filtered.length,
            next_offset: args.offset + page.length < filtered.length ? args.offset + page.length : null,
            courses: page.map((c) => {
              const cat = cats.get(c.categoryId);
              return {
                id: c.id,
                name: c.fullName,
                short_name: c.shortName,
                category: {
                  id: c.categoryId,
                  name: cat?.name ?? null,
                  path: cat ? cat.pathIds.map((id) => cats.get(id)?.name ?? String(id)).join(" / ") : null,
                },
                completion_tracked: c.completionEnabled,
                start_date: formatInZone(c.startDate, tz),
                end_date: formatInZone(c.endDate, tz),
              };
            }),
          },
        });
      }),
  );
}
