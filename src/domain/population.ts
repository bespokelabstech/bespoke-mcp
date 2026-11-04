import { mapLimit } from "@/core/concurrency";
import type { Course, LearningDataPort } from "@/ports/learning";
import type { TenantConfig } from "@/tenants/schema";
import type { Filters, PersonView, Status } from "./people";
import { classify, matchesFilters } from "./people";

/**
 * Loading the population behind a question: who is enrolled in the in-scope courses, with
 * their status and business attributes. Always pulled live from the LMS.
 */

/** One account's active enrolment in one in-scope course. */
export interface EnrolmentRecord {
  person: PersonView;
  course: Course;
  lastCourseAccess: number | null;
  lastSiteAccess: number | null;
}

/**
 * Two passes: (1) enrolments per course without profile fields; (2) profiles once per account.
 * Returns every enrolment that matches the dimension filters, of ANY status — callers select
 * the population and report the status counts.
 */
export interface ScopeData {
  records: EnrolmentRecord[];
  /** Region values seen BEFORE dimension filters (for "similar value" clarifications). */
  observedRegions: Set<string>;
}

export async function loadScope(
  port: LearningDataPort,
  tenant: TenantConfig,
  courses: Course[],
  filters: Filters,
): Promise<ScopeData> {
  const perCourse = await mapLimit(courses, tenant.limits.upstreamConcurrency, (c) =>
    port.listCourseEnrolments(c.id),
  );
  const userIds = [...new Set(perCourse.flat().map((e) => e.userId))];
  const profiles = await port.getProfiles(userIds);

  const views = new Map<number, PersonView>();
  const records: EnrolmentRecord[] = [];
  const observedRegions = new Set<string>();
  courses.forEach((course, i) => {
    for (const e of perCourse[i]!) {
      let view = views.get(e.userId);
      if (!view) {
        view = classify({ ...e, profile: profiles.get(e.userId) ?? {} }, tenant);
        views.set(e.userId, view);
      }
      // Roles are per course: the same account can be a learner here and a teacher elsewhere.
      const person: PersonView = hasLearnerRole(e.courseRoles, tenant)
        ? view
        : { ...view, status: "excluded", reason: "role", key: `u:${e.userId}` };
      observedRegions.add(person.region);
      if (!matchesFilters(person, filters, tenant.emptyValueLabel)) continue;
      records.push({
        person,
        course,
        lastCourseAccess: e.lastCourseAccess,
        lastSiteAccess: e.lastSiteAccess,
      });
    }
  });
  return { records, observedRegions };
}

function hasLearnerRole(roles: string[], tenant: TenantConfig): boolean {
  const { requiredCourseRoles, exclude } = tenant.eligibility;
  return (
    !roles.some((r) => exclude.courseRoles.includes(r)) && roles.some((r) => requiredCourseRoles.includes(r))
  );
}

export type StatusCounts = Record<Status, number>;

/** Status counts in the given unit (distinct people or enrolments). */
export function statusCounts(records: EnrolmentRecord[], unit: "people" | "enrolments"): StatusCounts {
  const seen: Record<Status, Set<string>> = { person: new Set(), legacy: new Set(), excluded: new Set() };
  for (const r of records) {
    seen[r.person.status].add(unit === "people" ? r.person.key : `${r.person.key}:${r.course.id}`);
  }
  return { person: seen.person.size, legacy: seen.legacy.size, excluded: seen.excluded.size };
}

export function selectPopulation(records: EnrolmentRecord[], statuses: readonly Status[]): EnrolmentRecord[] {
  const keep = new Set(statuses);
  return records.filter((r) => keep.has(r.person.status));
}
