/**
 * Engagement signals — named, separately defined measurements instead of one vague
 * "accessed". Definitions are mirrored in docs/METRICS.md and returned by
 * describe_capabilities so Claude can pick the right one and say what it means.
 */

export type SignalId = "started" | "completion" | "site_last_access" | "web_course_access" | "avg_score";
export const SIGNAL_IDS = [
  "started",
  "completion",
  "site_last_access",
  "web_course_access",
  "avg_score",
] as const satisfies readonly SignalId[];

export type SignalCost = "cheap" | "per_person" | "per_course";

export interface SignalDef {
  id: SignalId;
  label: string;
  definition: string;
  /** Does it reflect mobile-app activity? */
  seesAppActivity: boolean | "partial";
  /** Is it time-based (affected by recent_days / since / until)? */
  windowed: boolean;
  /** cheap = from the enrolment pull; per_person = one LMS call per person; per_course = one per course. */
  cost: SignalCost;
  caveat?: string;
}

export const SIGNALS: Record<SignalId, SignalDef> = {
  started: {
    id: "started",
    label: "Started",
    definition:
      "Completed at least one activity in the course (course progress > 0%) or completed the course.",
    seesAppActivity: true,
    windowed: false,
    cost: "per_person",
    caveat:
      "Opening a course or partly viewing an activity without completing it does not count. No date: the LMS does not expose when progress happened.",
  },
  completion: {
    id: "completion",
    label: "Completion",
    definition:
      "Course completion and progress % from the LMS, over enrolments in courses with completion tracking.",
    seesAppActivity: true,
    windowed: false,
    cost: "per_person",
  },
  site_last_access: {
    id: "site_last_access",
    label: "Last app/site access",
    definition: "The person's last access to the LMS site, including mobile-app logins. Not per course.",
    seesAppActivity: true,
    windowed: true,
    cost: "cheap",
    caveat: "Site-wide: it says the person used the app or site, not that they opened this course.",
  },
  web_course_access: {
    id: "web_course_access",
    label: "Last web course access",
    definition: "Last time the person opened the course in a web browser.",
    seesAppActivity: false,
    windowed: true,
    cost: "cheap",
    caveat:
      "Web only: mobile-app use does not update it (verified on staging), so it undercounts app users heavily. Never present it as overall course access.",
  },
  avg_score: {
    id: "avg_score",
    label: "Average score",
    definition:
      "Mean of graded quiz results (grade / max grade × 100) over graded quiz items of the people in scope.",
    seesAppActivity: true,
    windowed: false,
    cost: "per_course",
    caveat: "Only quizzes with a recorded grade count; ungraded or unattempted quizzes are excluded.",
  },
};

/** Default: started (skipped with a warning when the scope is too large for per-person calls) + site access. */
export const DEFAULT_SIGNALS: SignalId[] = ["started", "site_last_access"];
