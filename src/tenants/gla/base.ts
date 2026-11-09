import type { TenantConfigInput } from "../schema";

/**
 * GLA (PC GLASS dealer network on the Bihasa Moodle).
 * Field shortnames verified against the plugin/Go sources — see docs/METRICS.md#gla.
 */
const DUMMY = "^(?:(\\d)\\1*|(\\d{2,3})\\2+|1{10}\\d{2})$";

export const glaBase: TenantConfigInput = {
  id: "gla",
  displayName: "GLA (PC GLASS)",
  timezone: "Asia/Manila",
  vocabulary: {
    person: "Dealer",
    personPlural: "Dealers",
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
    // bihasa-moodle-go handlers/auth.go: Conso ID == lower-cased Moodle username for app dealers.
    profileField: "dealer_conso_id",
  },
  // BES-465 base scope: student role and no trainer or admin role, in that course.
  accounts: {
    learnerRoles: ["student"],
    nonLearnerRoles: ["editingteacher", "teacher", "manager", "coursecreator", "redemptionmanager"],
  },
  savedFilters: {
    valid_dealers: {
      label: "Valid dealers",
      // Bespoke's starting rules (mvp3 patterns, minus COE, which is a level default) until the
      // GLA team sends theirs.
      provisional: true,
      note: "Provisional rules until the GLA team confirms the list.",
      reject: [
        // One digit repeated (0, 000, 111111111111); a 2–3 digit block repeated (123123123123) —
        // 4+ digit blocks are NOT matched, 0001 0001 0001 could be branch + sequence; the
        // 1111111111xx test series (also covers the staging UAT pool 111111111119–169).
        { field: "conso_id", op: "matches", value: DUMMY, label: "Dummy Conso ID" },
        { field: "username", op: "matches", value: DUMMY, label: "Dummy username" },
      ],
    },
  },
  defaults: {
    savedFilter: "valid_dealers",
    // BES-465: all levels except PC Center of Excellence (staff), by default.
    exclude: { level: ["PC Center of Excellence"] },
  },
  courses: {
    includeCategoryIds: [],
    excludeCourseIds: [],
  },
  limits: {
    maxCoursesPerRequest: 40,
    participantsPageSize: 500,
    maxPeopleForPersonSignals: 300,
    upstreamConcurrency: 2,
    requestBudgetMs: 50_000,
    cacheTtlSeconds: 300,
  },
  environments: {
    staging: { moodleAllowedHosts: ["gla-staging.bihasa.ph"], vercelPreviewBranches: ["release"] },
    production: { moodleAllowedHosts: ["gla.bihasa.ph"], vercelPreviewBranches: [] },
  },
};
