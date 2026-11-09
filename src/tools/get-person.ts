import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AppError } from "@/core/errors";
import { buildEnvelope } from "@/domain/envelope";
import { isAccessed, pct } from "@/domain/metrics";
import { classify, shownIdentifier } from "@/domain/people";
import { tenantCourses } from "@/domain/scope";
import { formatInZone, inWindow, resolveWindow } from "@/domain/time";
import type { ToolDeps } from "./runtime";
import { READ_ONLY_ANNOTATIONS, requireLearning, runTool } from "./runtime";
import { savedFilter, windowFields } from "./shared-schemas";

export function registerGetPerson(server: McpServer, deps: ToolDeps): void {
  const t = deps.tenant;
  const v = t.vocabulary;
  server.registerTool(
    "get_person",
    {
      title: `${v.person} detail`,
      description:
        `One account by username (for app ${v.personPlural.toLowerCase()}, the ${t.identity.label}): valid or not, profile values, ` +
        `last sign-in, and every in-scope ${v.course.toLowerCase()} they are enrolled in with accessed, progress %, completed ` +
        `and last web access. ` +
        `To find someone by name, use list_people with 'search' first.`,
      inputSchema: z.strictObject({
        identifier: z
          .string()
          .min(3)
          .max(64)
          .describe(`Username / ${t.identity.label}, case-insensitive, exactly as stored (never repaired).`),
        ...windowFields(t),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) =>
      runTool("get_person", deps, args, async () => {
        const port = requireLearning(deps);
        const now = deps.nowSec();
        const window = resolveWindow(args, t.timezone, now);
        const record = await port.findPersonByUsername(args.identifier.trim().toLowerCase());
        if (!record) {
          throw new AppError(
            "not_found",
            `No account with username "${args.identifier}". Older accounts may use a different username — try list_people with 'search'.`,
          );
        }
        const view = classify({ ...record, profile: record.fields }, t);
        const [enrolments, scope] = await Promise.all([
          port.listPersonCourses(record.userId),
          tenantCourses(port, t),
        ]);
        const inScope = new Set(scope.map((c) => c.id));
        const courses = enrolments
          .filter((c) => inScope.has(c.courseId))
          .map((c) => ({ ...c, accessed: isAccessed(c) }))
          .sort((a, b) => Number(b.accessed) - Number(a.accessed) || a.fullName.localeCompare(b.fullName));

        const completed = courses.filter((c) => c.completionEnabled && c.completed === true).length;
        const warnings: string[] = [];
        const sf = savedFilter(t);
        if (sf && !view.valid) {
          warnings.push(`This account is not one of the ${sf.label}: ${view.failed.join(", ")}.`);
        }
        if (record.suspended) warnings.push("This account is suspended.");
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
              username: view.username,
              conso_id: shownIdentifier(view).value,
              ...(shownIdentifier(view).fromUsername ? { conso_id_from_username: true } : {}),
              identifier_label: t.identity.label,
              ...(sf ? { valid: view.valid } : {}),
              ...(view.failed.length ? { not_valid_because: view.failed } : {}),
              region: view.region,
              level: view.level,
              branch: view.branch.label,
              branch_name: view.branch.name ?? t.emptyValueLabel,
              branch_code: view.branch.code ?? t.emptyValueLabel,
              last_sign_in: formatInZone(record.lastSiteAccess, t.timezone),
              ...(window ? { logged_in_in_range: inWindow(record.lastSiteAccess, window) } : {}),
            },
            totals: {
              enrolled: courses.length,
              accessed: courses.filter((c) => c.accessed).length,
              completed,
              avg_completion_pct: pct(completed, courses.length),
              web_course_access_ever: courses.filter((c) => c.lastAccess !== null).length,
            },
            courses: courses.map((c) => ({
              id: c.courseId,
              name: c.fullName,
              accessed: c.accessed,
              progress_pct: c.progressPct,
              completed: c.completed,
              completion_tracked: c.completionEnabled,
              web_course_access: formatInZone(c.lastAccess, t.timezone),
            })),
          },
        });
      }),
  );
}
