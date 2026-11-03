import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AppError } from "@/core/errors";
import { pct } from "@/domain/access";
import { buildEnvelope } from "@/domain/envelope";
import { personIneligibility, toPersonView } from "@/domain/people";
import { tenantCourses } from "@/domain/scope";
import { formatInZone, inWindow, resolveWindow } from "@/domain/time";
import type { ToolDeps } from "./runtime";
import { READ_ONLY_ANNOTATIONS, requireLearning, runTool } from "./runtime";
import { windowFields } from "./shared-schemas";

/** Registered as get_<personKey>_access, e.g. get_dealer_access. */
export function registerGetPersonAccess(server: McpServer, deps: ToolDeps): void {
  const t = deps.tenant;
  const v = t.vocabulary;
  const name = `get_${v.personKey}_access`;
  server.registerTool(
    name,
    {
      title: `${v.person} access`,
      description:
        `For one ${v.person.toLowerCase()} (by ${t.identity.label}): profile attributes and every in-scope ` +
        `${v.course.toLowerCase()} they are enrolled in, with last access, progress % and completion. ` +
        `To find someone by name, use get_course_access with 'search' first.`,
      inputSchema: z.object({
        identifier: z.string().min(3).max(64).describe(`${t.identity.label} (case-insensitive).`),
        ...windowFields(t),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) =>
      runTool(name, deps, args, async () => {
        const port = requireLearning(deps);
        const now = deps.nowSec();
        const window = resolveWindow(args, t.timezone, now);
        const id = args.identifier.trim().toLowerCase();
        const person = await port.findPersonByUsername(id);
        if (!person) {
          throw new AppError(
            "not_found",
            `No account with ${t.identity.label} "${args.identifier}". Legacy accounts may use a different username — try get_course_access with 'search'.`,
          );
        }
        const view = toPersonView(person, t);
        const ineligible = personIneligibility(person, t);
        const [enrolments, scope] = await Promise.all([
          port.listPersonCourses(person.userId),
          tenantCourses(port, t),
        ]);
        const inScope = new Set(scope.map((c) => c.id));
        const courses = enrolments
          .filter((c) => inScope.has(c.courseId))
          .sort((a, b) => (b.lastAccess ?? -1) - (a.lastAccess ?? -1));

        const accessed = courses.filter((c) => c.lastAccess !== null).length;
        const tracked = courses.filter((c) => c.completionEnabled && c.completed !== null);
        const completed = tracked.filter((c) => c.completed).length;
        const warnings: string[] = [];
        if (ineligible)
          warnings.push(`This account is not counted as a ${v.person} in metrics (${ineligible}).`);
        if (person.suspended) warnings.push("This account is suspended.");
        if (window?.semantics === "last_access_in_range") warnings.push(window.description);

        return buildEnvelope({
          tenant: t,
          environment: deps.env,
          source: port.source,
          nowSec: now,
          window,
          warnings,
          data: {
            person: {
              name: view.name,
              identifier: view.identifier ?? t.emptyValueLabel,
              identifier_label: t.identity.label,
              region: view.region,
              level: view.level,
              branch: view.branch.label,
              branch_name: view.branch.name ?? t.emptyValueLabel,
              branch_code: view.branch.code ?? t.emptyValueLabel,
              counted_in_metrics: ineligible === null,
            },
            totals: {
              enrolled: courses.length,
              accessed,
              never_accessed: courses.length - accessed,
              ...(window
                ? { accessed_in_window: courses.filter((c) => inWindow(c.lastAccess, window)).length }
                : {}),
              completion_tracked: tracked.length,
              completed,
              completion_rate_pct: pct(completed, tracked.length),
            },
            courses: courses.map((c) => ({
              id: c.courseId,
              name: c.fullName,
              last_access: formatInZone(c.lastAccess, t.timezone),
              accessed: c.lastAccess !== null,
              progress_pct: c.progressPct,
              completed: c.completed,
              completion_tracked: c.completionEnabled,
            })),
          },
        });
      }),
  );
}
