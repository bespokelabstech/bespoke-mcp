import { mapLimit } from "@/core/concurrency";
import type { Course, Enrolment, LearningDataPort } from "@/ports/learning";
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
  const profiles = await port.getProfiles([...new Set(perCourse.flat().map((e) => e.userId))]);
  const out: ScopeData = { records: [], observedRegions: new Set() };
  const views = new Map<number, PersonView>();
  courses.forEach((course, i) => addRecords(out, views, course, perCourse[i]!, profiles, tenant, filters));
  return out;
}

export interface PageData extends ScopeData {
  /** True when this was the course's last page. */
  done: boolean;
}

/**
 * One page of one course (for answers in parts): the unit of work is small enough to fit a
 * call even for very large courses. Profiles are fetched for this page's accounts only.
 */
export async function loadScopePage(
  port: LearningDataPort,
  tenant: TenantConfig,
  course: Course,
  offset: number,
  filters: Filters,
): Promise<PageData> {
  const page = await port.listCourseEnrolmentsPage(course.id, offset, tenant.limits.participantsPageSize);
  const profiles = await port.getProfiles(page.rows.map((e) => e.userId));
  const out: ScopeData = { records: [], observedRegions: new Set() };
  addRecords(out, new Map(), course, page.rows, profiles, tenant, filters);
  return { ...out, done: page.done };
}

function addRecords(
  out: ScopeData,
  views: Map<number, PersonView>,
  course: Course,
  enrolments: Enrolment[],
  profiles: Map<number, Record<string, string>>,
  tenant: TenantConfig,
  filters: Filters,
): void {
  for (const e of enrolments) {
    let view = views.get(e.userId);
    if (!view) {
      view = classify({ ...e, profile: profiles.get(e.userId) ?? {} }, tenant);
      views.set(e.userId, view);
    }
    // Roles are per course: the same account can be a learner here and a teacher elsewhere.
    const person: PersonView = hasLearnerRole(e.courseRoles, tenant)
      ? view
      : { ...view, status: "excluded", reason: "role", key: `u:${e.userId}` };
    out.observedRegions.add(person.region);
    if (!matchesFilters(person, filters, tenant.emptyValueLabel)) continue;
    out.records.push({
      person,
      course,
      lastCourseAccess: e.lastCourseAccess,
      lastSiteAccess: e.lastSiteAccess,
    });
  }
}

function hasLearnerRole(roles: string[], tenant: TenantConfig): boolean {
  const { requiredCourseRoles, exclude } = tenant.eligibility;
  return (
    !roles.some((r) => exclude.courseRoles.includes(r)) && roles.some((r) => requiredCourseRoles.includes(r))
  );
}

export type StatusCounts = Record<Status, number>;

/**
 * Status counts in the given unit: distinct people (duplicate accounts of a Dealer merge) or
 * enrolments (account × course, as Moodle records them — additive across parts).
 */
export function statusCounts(records: EnrolmentRecord[], unit: "people" | "enrolments"): StatusCounts {
  const seen: Record<Status, Set<string>> = { person: new Set(), legacy: new Set(), excluded: new Set() };
  for (const r of records) {
    seen[r.person.status].add(unit === "people" ? r.person.key : enrolmentKey(r));
  }
  return { person: seen.person.size, legacy: seen.legacy.size, excluded: seen.excluded.size };
}

export function selectPopulation(records: EnrolmentRecord[], statuses: readonly Status[]): EnrolmentRecord[] {
  const keep = new Set(statuses);
  return records.filter((r) => keep.has(r.person.status));
}

/** One account's enrolment in one course. */
export function enrolmentKey(r: EnrolmentRecord): string {
  return `u:${r.person.userId}:${r.course.id}`;
}

/**
 * Accounts merged into another account of the same person (same identifier) — the
 * difference between counted accounts and counted people. Shown so totals are explainable.
 */
export function mergedDuplicateAccounts(records: EnrolmentRecord[]): number {
  const people = records.filter((r) => r.person.status === "person");
  return new Set(people.map((r) => r.person.userId)).size - new Set(people.map((r) => r.person.key)).size;
}
