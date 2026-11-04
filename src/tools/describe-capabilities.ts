import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DEFINITIONS_VERSION } from "@/domain/envelope";
import { SIGNAL_IDS, SIGNALS } from "@/domain/signals";
import type { ToolDeps } from "./runtime";
import { READ_ONLY_ANNOTATIONS, runTool } from "./runtime";
import { populationValues } from "./shared-schemas";

export function registerDescribeCapabilities(server: McpServer, deps: ToolDeps): void {
  const t = deps.tenant;
  const v = t.vocabulary;
  server.registerTool(
    "describe_capabilities",
    {
      title: "What this connector can answer",
      description:
        "The engagement signals, dimensions, populations and limits available in this deployment, with exact definitions. " +
        "Call it first when unsure which signal answers a question (e.g. what 'access' should mean) or why a number may be limited.",
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) =>
      runTool("describe_capabilities", deps, args, async () => {
        const caps = deps.learning ? await deps.learning.capabilities() : null;
        const [person] = populationValues(t);
        return {
          tenant: t.id,
          environment: deps.env,
          source: deps.learning?.source ?? null,
          lms_configured: deps.learning !== null,
          definitions_version: DEFINITIONS_VERSION,
          timezone: t.timezone,
          vocabulary: { person: v.person, course: v.course, identifier: t.identity.label },
          signals: SIGNAL_IDS.map((id) => {
            const s = SIGNALS[id];
            return {
              id,
              label: s.label,
              definition: s.definition,
              sees_app_activity: s.seesAppActivity,
              time_window: s.windowed,
              cost: s.cost,
              available: caps === null ? false : id === "avg_score" ? caps.grades : true,
              ...(s.caveat ? { caveat: s.caveat } : {}),
            };
          }),
          dimensions: Object.fromEntries(
            Object.entries(t.dimensions).map(([id, d]) => [
              id,
              { label: d.label, profile_field: d.profileField },
            ]),
          ),
          population: {
            [person]: `Valid ${t.identity.label} (${t.identity.validPattern}, after trimming/lower-casing and repairing a dropped leading zero), not excluded. Counted once per ${t.identity.label}.`,
            legacy: `No ${t.identity.label}, or one in an old/malformed format. Shown, not counted by default.`,
            excluded: `Test accounts, dummy ${t.identity.label}s, staff (${t.dimensions.level.label}: ${t.eligibility.exclude.staffLevels.join(", ") || "none"}), or non-learner roles. Shown, not counted by default.`,
            default: [person],
          },
          limits: {
            max_courses_per_request: t.limits.maxCoursesPerRequest,
            max_people_for_per_person_signals: t.limits.maxPeopleForPersonSignals,
            answers_in_parts:
              "Large questions continue via next_cursor: enrolment-level ones page through courses (even mid-course); " +
              "per-person signals (started, completion) run in batches of people; avg_score is skipped alongside them (ask separately).",
          },
          notes: [
            `Profile values are reported exactly as stored; "${t.emptyValueLabel}" = empty. Similar-looking values (e.g. "Visayas" and "Visayas 1") are separate values.`,
            "Nothing is stored by this server; every answer is pulled live (a few minutes of in-memory caching at most).",
          ],
        };
      }),
  );
}
