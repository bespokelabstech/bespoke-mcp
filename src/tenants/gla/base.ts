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
    course: "Course",
    coursePlural: "Courses",
  },
  // BES-465 wording for an empty value (e.g. Region "Not set").
  emptyValueLabel: "Not set",
  dimensions: {
    // local_profileform/classes/catalog.php REGION_FIELD
    region: { label: "Region", profileField: "Region_Dropdown", format: "verbatim" },
    // local_dealerlevels/lib.php: Dealer Level menu, shortname `level`
    level: {
      label: "Dealer Level",
      profileField: "level",
      format: "verbatim",
      // The 4 dealer levels + COE (sampled on staging 2026-11-09). Anything else is warned about.
      expectedValues: [
        "Great Life Builder",
        "Great Life Manager",
        "Great Life Director",
        "Great Life Executive",
        "PC Center of Excellence",
      ],
    },
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
  // BES-465 "valid_dealers": hide any account that matches at least one rule. Patterns are
  // Bespoke's reading of the rule table (pending confirmation from Jona); values are lower-cased.
  savedFilters: {
    valid_dealers: {
      label: "Valid dealers",
      provisional: true,
      note: "BES-465 rules, pending confirmation from Jona. Patterns are Bespoke's reading of the rule table.",
      hide: [
        // 1. Internal email domains (only the "@domain" is ever read).
        {
          field: "email",
          op: "matches",
          value: "@(bihasa\\.ph|bespokelabs\\.tech|training\\.net)$",
          label: "Internal email domain",
        },
        // 2. Training / test / admin usernames.
        {
          field: "username",
          op: "matches",
          value: "^(gla|glass)\\.train|test|admin",
          label: "Test, training or admin username",
        },
        // 3. Test or dummy name (whole words), or "Admin User".
        {
          field: "name",
          op: "matches",
          value: "\\b(dummy|test|sample|demo|student|try)\\b",
          label: "Test or dummy name",
        },
        { field: "name", op: "equals", value: "admin user", label: "Test or dummy name" },
        // 4. Dummy Conso ID in the username: 9991 series; one digit repeated 6+ times with an
        //    optional suffix of up to 3 digits (0000000, 111111111111, 111111111125 — also the
        //    staging UAT pool 111111111119–169); or starting 123456789.
        {
          field: "username",
          op: "matches",
          value: "^9991|^(\\d)\\1{5,}\\d{0,3}$|^123456789",
          label: "Dummy Conso ID",
        },
        // 5. Placeholder name: blank, "PC SFLMS Live", or starting with a legacy username
        //    such as cl_0106_00003.
        { field: "name", op: "equals", value: "", label: "Placeholder name" },
        { field: "name", op: "matches", value: "pc sflms live", label: "Placeholder name" },
        {
          field: "name",
          op: "matches",
          value: "^[a-z]+\\d*_[0-9a-z]{3,5}_\\d+",
          label: "Placeholder name",
        },
        // 6. Suspended account.
        { field: "status", op: "equals", value: "suspended", label: "Suspended account" },
        // 7. Dealer Level is PC Center of Excellence or blank.
        {
          field: "level",
          op: "in",
          value: ["PC Center of Excellence", ""],
          label: "COE or blank Dealer Level",
        },
      ],
    },
  },
  defaults: { savedFilter: "valid_dealers" },
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
