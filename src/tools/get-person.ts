import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AppError } from "@/core/errors";
import { pct } from "@/domain/metrics";
import { buildEnvelope } from "@/domain/envelope";
import { classify, normaliseIdentifier } from "@/domain/people";
import { tenantCourses } from "@/domain/scope";
import { formatInZone, inWindow, resolveWindow } from "@/domain/time";
import type { ToolDeps } from "./runtime";
import { READ_ONLY_ANNOTATIONS, requireLearning, runTool } from "./runtime";
import { statusLabel, windowFields } from "./shared-schemas";

export function registerGetPerson(server: McpServer, deps: ToolDeps): void {
  const t = deps.tenant;
  const v = t.vocabulary;
  server.registerTool(
    "get_person",
    {
      title: `${v.person} detail`,
      description:
        `One ${v.person.toLowerCase()} by ${t.identity.label}: status, profile values, last app/site access, and every in-scope ` +
        `${v.course.toLowerCase()} they are enrolled in with started, progress %, completion and last web access. ` +
        `To find someone by name, use list_people with 'search' first.`,
      inputSchema: z.object({
        identifier: z
          .string()
          .min(3)
          .max(64)
          .describe(`${t.identity.label} (case-insensitive; a dropped leading zero is repaired).`),
        ...windowFields(t),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) =>
      runTool("get_person", deps, args, async () => {
        const port = requireLearning(deps);
        const now = deps.nowSec();
        const window = resolveWindow(args, t.timezone, now);
        const raw = args.identifier.trim().toLowerCase();
        const norm = normaliseIdentifier(raw, t).value;
        const record =
          (await port.findPersonByUsername(norm)) ??
          (norm !== raw ? await port.findPersonByUsername(raw) : null);
        if (!record) {
          throw new AppError(
            "not_found",
            `No account with ${t.identity.label} "${args.identifier}" as its username. Legacy accounts may use a different username — try list_people with 'search'.`,
          );
        }
        const view = classify(record, t);
        const [enrolments, scope] = await Promise.all([
          port.listPersonCourses(record.userId),
          tenantCourses(port, t),
        ]);
        const inScope = new Set(scope.map((c) => c.id));
        const courses = enrolments
          .filter((c) => inScope.has(c.courseId))
          .map((c) => ({ ...c, started: c.completed === true || (c.progressPct ?? 0) > 0 }))
          .sort((a, b) => Number(b.started) - Number(a.started) || a.fullName.localeCompare(b.fullName));

        const tracked = courses.filter((c) => c.completionEnabled && c.completed !== null);
        const completed = tracked.filter((c) => c.completed).length;
        const warnings: string[] = [];
        if (view.status !== "person") {
          warnings.push(
            `This account is not counted as a ${v.person} (status: ${statusLabel(view.status, t)}${view.reason ? `, ${view.reason}` : ""}).`,
          );
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
              identifier: view.identifier ?? t.emptyValueLabel,
              identifier_label: t.identity.label,
              ...(view.identifierNormalised ? { identifier_repaired: true } : {}),
              status: statusLabel(view.status, t),
              ...(view.reason ? { excluded_reason: view.reason } : {}),
              region: view.region,
              level: view.level,
              branch: view.branch.label,
              branch_name: view.branch.name ?? t.emptyValueLabel,
              branch_code: view.branch.code ?? t.emptyValueLabel,
              site_last_access: formatInZone(record.lastSiteAccess, t.timezone),
              ...(window ? { site_access_in_window: inWindow(record.lastSiteAccess, window) } : {}),
            },
            totals: {
              enrolled: courses.length,
              started: courses.filter((c) => c.started).length,
              completion_tracked: tracked.length,
              completed,
              completion_rate_pct: pct(completed, tracked.length),
              web_course_access_ever: courses.filter((c) => c.lastAccess !== null).length,
            },
            courses: courses.map((c) => ({
              id: c.courseId,
              name: c.fullName,
              started: c.started,
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
