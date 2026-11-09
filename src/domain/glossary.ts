/**
 * The BES-465 glossary ("Compliance Dashboard v2"), word for word, so this connector and the
 * dashboard use the same labels with the same meaning. `in_this_connector` says where this
 * connector — reading Moodle's standard web services live, with no session tracking or
 * reporting tables — measures a term differently or cannot measure it. Those notes go away
 * once the connector can read the dashboard's reporting API (see docs/ROADMAP.md).
 */

export type Availability = "exact" | "approximate" | "not_available" | "different_source";

export interface GlossaryEntry {
  label: string;
  meaning: string;
  availability: Availability;
  in_this_connector?: string;
}

export const GLOSSARY_SOURCE = "BES-465 Compliance Dashboard v2 — Definitions";

export const GLOSSARY: GlossaryEntry[] = [
  {
    label: "Account",
    meaning:
      "A learner account: has the student role and no trainer or admin role. Always applied, not a filter.",
    availability: "approximate",
    in_this_connector:
      "Roles are read per course (student, and none of teacher, non-editing teacher, manager, course creator, redemption manager in that course). Site-level admin roles are not visible.",
  },
  {
    label: "Valid dealer",
    meaning: "Matches the `valid_dealers` saved filter (rules from the GLA team)",
    availability: "exact",
    in_this_connector: "Rules are provisional until the GLA team confirms them; see saved_filters.",
  },
  {
    label: "Enrolled",
    meaning: "Enrolled in the course. Enrolment differs by Dealer Level (`local_enrolrules`).",
    availability: "exact",
  },
  {
    label: "Logged in",
    meaning: "Signed in to the app at least once. Within a date range: had a session in the range.",
    availability: "approximate",
    in_this_connector:
      "Uses the last sign-in only (app sign-in or web visit). Exact for ranges ending today; a range ending in the past under-counts people who also signed in later.",
  },
  {
    label: "Sessions",
    meaning: "App use. A new session starts after 30 minutes idle.",
    availability: "not_available",
    in_this_connector: "Not available: needs session tracking.",
  },
  {
    label: "Days active",
    meaning: "Days with at least one session",
    availability: "not_available",
    in_this_connector: "Not available: needs session tracking.",
  },
  {
    label: "Last active",
    meaning: "Last app use. Falls back to last sign-in until session data exists.",
    availability: "approximate",
    in_this_connector: "Shows the last sign-in (the fallback).",
  },
  {
    label: "Accessed",
    meaning:
      "Completed at least one activity in the course. Within a date range: completed one in the range.",
    availability: "approximate",
    in_this_connector: "All-time only; a date range is not applied (a warning says so).",
  },
  {
    label: "Access rate",
    meaning: "Accessed ÷ logged in, for a course",
    availability: "approximate",
    in_this_connector: "Not computed when a date range is set (null with a warning).",
  },
  {
    label: "Progress",
    meaning: "% of a course's activities completed",
    availability: "exact",
  },
  {
    label: "First / Last progress",
    meaning: "Dates of the first and latest completed activity in a course",
    availability: "not_available",
    in_this_connector: "Not available: completion dates are not exposed in bulk.",
  },
  {
    label: "Completed / Avg. completion",
    meaning: "Finished the course / share of enrolments completed",
    availability: "exact",
  },
  {
    label: "Region",
    meaning: "Region is taken from the dealer's branch in Branches & Regions.",
    availability: "different_source",
    in_this_connector:
      "Uses the Region value stored on the dealer's profile, which can differ from the branch's region in Branches & Regions.",
  },
];

export const GLOSSARY_NOTES = ["Days run midnight to midnight, Manila time."];
