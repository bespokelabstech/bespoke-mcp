/**
 * Metrics a query can ask for. Names follow the BES-465 glossary (see glossary.ts); definitions
 * are mirrored in docs/METRICS.md and returned by describe_capabilities.
 */

export type SignalId = "logged_in" | "accessed" | "progress" | "web_course_access" | "avg_score";
export const SIGNAL_IDS = [
  "logged_in",
  "accessed",
  "progress",
  "web_course_access",
  "avg_score",
] as const satisfies readonly SignalId[];

export type SignalCost = "cheap" | "per_person" | "per_course";

export interface SignalDef {
  id: SignalId;
  label: string;
  /** What this connector returns (the glossary meaning plus how it is measured here). */
  returns: string;
  /** Does it reflect mobile-app activity? */
  seesAppActivity: boolean;
  /** Does a date range (recent_days / from / to) apply to it? */
  dateRange: "exact_up_to_now" | "not_applied" | "applied";
  /** cheap = from the enrolment pull; per_person = one LMS call per account; per_course = one per course. */
  cost: SignalCost;
  caveat?: string;
}

export const SIGNALS: Record<SignalId, SignalDef> = {
  logged_in: {
    id: "logged_in",
    label: "Logged in",
    returns:
      "Accounts with a last sign-in (app sign-in or web visit); share of enrolled. With a date range: last sign-in inside the range.",
    seesAppActivity: true,
    dateRange: "exact_up_to_now",
    cost: "cheap",
    caveat:
      "Only the last sign-in is known, so a range ending in the past under-counts people who also signed in later.",
  },
  accessed: {
    id: "accessed",
    label: "Accessed",
    returns:
      "Accounts that completed at least one activity in the course (progress > 0% or completed), and the access rate (accessed ÷ logged in).",
    seesAppActivity: true,
    dateRange: "not_applied",
    cost: "per_person",
    caveat:
      "All-time only: completion dates are not available in bulk, so a date range is not applied to Accessed and the access rate is not computed with one.",
  },
  progress: {
    id: "progress",
    label: "Progress / Completed / Avg. completion",
    returns:
      "Average progress % over enrolments with completion tracking; enrolments completed; avg. completion = completed ÷ enrolled.",
    seesAppActivity: true,
    dateRange: "not_applied",
    cost: "per_person",
  },
  web_course_access: {
    id: "web_course_access",
    label: "Last web course access",
    returns: "Accounts that opened the course in a web browser (ever, or inside the date range).",
    seesAppActivity: false,
    dateRange: "exact_up_to_now",
    cost: "cheap",
    caveat:
      "Web only: mobile-app use does not update it (verified on staging), so it undercounts app users heavily. Never present it as overall course access.",
  },
  avg_score: {
    id: "avg_score",
    label: "Average score",
    returns: "Mean of graded quiz results (grade / max grade × 100) over graded quiz items.",
    seesAppActivity: true,
    dateRange: "not_applied",
    cost: "per_course",
    caveat: "Only quizzes with a recorded grade count; ungraded or unattempted quizzes are excluded.",
  },
};

/** Default: Accessed + Logged in. */
export const DEFAULT_SIGNALS: SignalId[] = ["accessed", "logged_in"];
export const PER_PERSON_SIGNALS: SignalId[] = ["accessed", "progress"];
