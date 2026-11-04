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
    // bihasa-moodle-go handlers/auth.go: Conso ID == lower-cased Moodle username, 12 chars.
    // Sampled on staging: BBBB + 8 digits (BBBB = branch code) and PC alphanumeric variants.
    validPattern: "^[a-z0-9]{12}$",
    // Sampled: 11-digit IDs are the same Dealer with the leading zero dropped.
    padNumericFrom: 11,
    padNumericTo: 12,
  },
  eligibility: {
    requiredCourseRoles: ["student"],
    legacyLabel: "Legacy",
    exclude: {
      usernames: [],
      usernameRanges: [],
      courseRoles: ["redemptionmanager"],
      // Sampled: every staff row (4-digit employee numbers, "pc…" ids) carries this level.
      staffLevels: ["PC Center of Excellence"],
      dummyIdentifierPatterns: [
        "^(\\d)\\1*$", // one digit repeated, any length: 0, 000, 00000, 111111111111
        // short block repeated to fill the id: 123123123123, 121212121212. Blocks of 4+ are NOT
        // matched: canonical ids are branch(4) + sequence, e.g. 0001 0001 0001 could be real.
        "^(\\d{2,3})\\1+$",
        "^1{10}\\d{2}$", // 1111111111xx test series, e.g. 111111111112
      ],
    },
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
