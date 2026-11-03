import type { TenantConfigInput } from "../schema";

/**
 * GLA (PC GLASS dealer network on the Bihasa Moodle).
 * Field shortnames verified against the plugin/Go sources — see docs/METRICS.md#gla.
 */
export const glaBase: TenantConfigInput = {
  id: "gla",
  displayName: "GLA (PC GLASS)",
  timezone: "Asia/Manila",
  vocabulary: {
    person: "Dealer",
    personPlural: "Dealers",
    personKey: "dealer",
    course: "Course",
    coursePlural: "Courses",
  },
  emptyValueLabel: "N/A",
  dimensions: {
    // local_profileform/classes/catalog.php REGION_FIELD
    region: { label: "Region", profileField: "Region_Dropdown", format: "verbatim" },
    // local_dealerlevels/lib.php: Dealer Level menu, shortname `level`
    level: { label: "Dealer Level", profileField: "level", format: "verbatim" },
    // local_profileform/classes/catalog.php CHILD; "NAME (0032)", legacy bare "0032"
    branch: { label: "Branch", profileField: "branch_code", format: "name_with_code" },
  },
  identity: {
    label: "Conso ID",
    profileField: "dealer_conso_id",
    // bihasa-moodle-go handlers/auth.go: Conso ID == lower-cased Moodle username
    usernamePattern: "^[a-z0-9]{12}$",
  },
  eligibility: {
    requiredCourseRoles: ["student"],
    requireIdentity: true,
    exclude: {
      usernames: [],
      usernameRanges: [],
      courseRoles: ["redemptionmanager"],
    },
  },
  courses: {
    includeCategoryIds: [],
    excludeCourseIds: [],
  },
  limits: {
    maxCoursesPerRequest: 40,
    participantsPageSize: 500,
    maxPeopleForCompletion: 300,
    upstreamConcurrency: 4,
    requestBudgetMs: 50_000,
    cacheTtlSeconds: 900,
  },
  environments: {
    staging: { moodleAllowedHosts: ["gla-staging.bihasa.ph"], vercelPreviewBranches: ["release"] },
    production: { moodleAllowedHosts: ["gla.bihasa.ph"], vercelPreviewBranches: [] },
  },
};
