import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DEFINITIONS_VERSION } from "@/domain/envelope";
import { GLOSSARY, GLOSSARY_NOTES, GLOSSARY_SOURCE } from "@/domain/glossary";
import { METRIC_SORT_KEYS } from "@/domain/metrics";
import { SIGNAL_IDS, SIGNALS } from "@/domain/signals";
import { DIMENSION_IDS } from "@/tenants/schema";
import type { ToolDeps } from "./runtime";
import { READ_ONLY_ANNOTATIONS, runTool } from "./runtime";

export function registerDescribeCapabilities(server: McpServer, deps: ToolDeps): void {
  const t = deps.tenant;
  const v = t.vocabulary;
  server.registerTool(
    "describe_capabilities",
    {
      title: "What this connector can answer",
      description:
        "The glossary (same labels and meanings as the dashboard, with notes where this connector differs), the saved " +
        "filter and its conditions, the defaults, the metrics, sortable columns and limits. Call it first when unsure " +
        "what a label means, which metric answers a question, or why a number may be limited.",
      inputSchema: z.strictObject({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) =>
      runTool("describe_capabilities", deps, args, async () => {
        const caps = deps.learning ? await deps.learning.capabilities() : null;
        const defaultExclude = Object.fromEntries(
          DIMENSION_IDS.filter((d) => t.defaults.exclude[d].length).map((d) => [d, t.defaults.exclude[d]]),
        );
        return {
          tenant: t.id,
          environment: deps.env,
          source: deps.learning?.source ?? null,
          lms_configured: deps.learning !== null,
          definitions_version: DEFINITIONS_VERSION,
          timezone: t.timezone,
          vocabulary: { person: v.person, course: v.course, identifier: t.identity.label },
          glossary: { source: GLOSSARY_SOURCE, terms: GLOSSARY, notes: GLOSSARY_NOTES },
          base_scope: {
            description:
              "Always applied, not a filter: only learner accounts count. An enrolment counts when the account has " +
              `one of [${t.accounts.learnerRoles.join(", ")}] and none of [${t.accounts.nonLearnerRoles.join(", ")}] in that course.`,
          },
          saved_filters: Object.fromEntries(
            Object.entries(t.savedFilters).map(([key, f]) => [
              key,
              {
                label: f.label,
                provisional: f.provisional,
                ...(f.note ? { note: f.note } : {}),
                matching:
                  "Field values are trimmed and lower-cased; conso_id is the profile value as stored (empty when missing); " +
                  "an account passes when it meets every 'require' condition and no 'reject' condition.",
                require: f.require,
                reject: f.reject,
              },
            ]),
          ),
          defaults: {
            valid_only: t.defaults.savedFilter !== null,
            saved_filter: t.defaults.savedFilter,
            exclude: defaultExclude,
            how_to_override:
              "valid_only=false counts every learner account. A default exclude list applies only when neither filters " +
              "nor exclude is set for that dimension; pass an empty list (e.g. exclude: {level: []}) to include those values.",
            sort: { query_metrics: "-enrolled", list_people: "name" },
          },
          counting:
            "Every account counts on its own: accounts are never merged and identifiers are never repaired. " +
            "count_by accounts (default) or enrolments; grouping by course always counts enrolments.",
          signals: SIGNAL_IDS.map((id) => {
            const s = SIGNALS[id];
            return {
              id,
              label: s.label,
              returns: s.returns,
              sees_app_activity: s.seesAppActivity,
              date_range: s.dateRange,
              cost: s.cost,
              available: caps === null ? false : id === "avg_score" ? caps.grades : true,
              ...(s.caveat ? { caveat: s.caveat } : {}),
            };
          }),
          sortable: {
            query_metrics: Object.keys(METRIC_SORT_KEYS),
            list_people: [
              "name",
              "conso_id",
              "region",
              "branch",
              "level",
              "last_sign_in",
              "web_course_access",
              "progress",
              "accessed",
            ],
            direction: "prefix '-' for descending, e.g. -last_sign_in; nulls sort last",
          },
          dimensions: Object.fromEntries(
            Object.entries(t.dimensions).map(([id, d]) => [
              id,
              { label: d.label, profile_field: d.profileField },
            ]),
          ),
          not_available: [
            "Sessions, Days active and Last active from session data (needs session tracking).",
            "Accessed within a date range and First / Last progress (needs completion dates in bulk).",
            "Region from Branches & Regions (the profile value is used instead).",
          ],
          limits: {
            max_courses_per_request: t.limits.maxCoursesPerRequest,
            list_people_per_person_limit: t.limits.maxPeopleForPersonSignals,
            answers_in_parts:
              "Large questions continue via next_cursor: enrolment-level ones page through courses (even mid-course); " +
              "accessed/progress run in batches of accounts; avg_score is skipped alongside them (ask separately).",
          },
          notes: [
            `Profile values are reported exactly as stored; "${t.emptyValueLabel}" = empty. Similar-looking values (e.g. "Visayas" and "Visayas 1") are separate values.`,
            "Nothing is stored by this server; every answer is pulled live (a few minutes of in-memory caching at most).",
          ],
        };
      }),
  );
}
