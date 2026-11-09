import { mapLimit } from "@/core/concurrency";
import type { Course, Enrolment, LearningDataPort } from "@/ports/learning";
import type { TenantConfig } from "@/tenants/schema";
import type { Filters, PersonView } from "./people";
import { classify, isLearner, matchesFilters } from "./people";

/**
 * Loading the population behind a question: the learner accounts enrolled in the in-scope
 * courses, with their business attributes and saved-filter verdict. Always pulled live.
 */

/** One learner account's active enrolment in one in-scope course. */
export interface EnrolmentRecord {
  person: PersonView;
  course: Course;
  lastCourseAccess: number | null;
  lastSiteAccess: number | null;
}

/**
 * Two passes: (1) enrolments per course without profile fields; (2) profiles once per account.
 * Returns every LEARNER enrolment that matches the dimension filters, valid or not — callers
 * apply the saved filter and report the population counts. Non-learner enrolments (trainers,
 * admins) are dropped here: the base scope is always applied.
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
  const learners = perCourse.map((rows) => rows.filter((e) => isLearner(e.courseRoles, tenant)));
  const profiles = await port.getProfiles([...new Set(learners.flat().map((e) => e.userId))]);
  const out: ScopeData = { records: [], observedRegions: new Set() };
  const views = new Map<number, PersonView>();
  courses.forEach((course, i) => addRecords(out, views, course, learners[i]!, profiles, tenant, filters));
  return out;
}

export interface PageData extends ScopeData {
  /** True when this was the course's last page. */
  done: boolean;
}

/**
 * One page of one course (for answers in parts): the unit of work is small enough to fit a
 * call even for very large courses. Profiles are fetched for this page's learners only.
 */
export async function loadScopePage(
  port: LearningDataPort,
  tenant: TenantConfig,
  course: Course,
  offset: number,
  filters: Filters,
): Promise<PageData> {
  const page = await port.listCourseEnrolmentsPage(course.id, offset, tenant.limits.participantsPageSize);
  const learners = page.rows.filter((e) => isLearner(e.courseRoles, tenant));
  const profiles = await port.getProfiles(learners.map((e) => e.userId));
  const out: ScopeData = { records: [], observedRegions: new Set() };
  addRecords(out, new Map(), course, learners, profiles, tenant, filters);
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
    let person = views.get(e.userId);
    if (!person) {
      person = classify({ ...e, profile: profiles.get(e.userId) ?? {} }, tenant);
      views.set(e.userId, person);
    }
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

/**
 * Population counts in the answer's unit: all accounts in scope, how many pass the saved filter,
 * and why the rest do not (first failed condition per account). Additive for enrolments.
 */
export interface PopulationCounts {
  all: number;
  valid: number;
  /** condition label -> count */
  notValid: Record<string, number>;
}

export function emptyCounts(): PopulationCounts {
  return { all: 0, valid: 0, notValid: {} };
}

export function populationCounts(
  records: EnrolmentRecord[],
  unit: "accounts" | "enrolments",
): PopulationCounts {
  const seen = new Set<string>();
  const out = emptyCounts();
  for (const r of records) {
    const k = unit === "accounts" ? `u:${r.person.userId}` : enrolmentKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.all++;
    if (r.person.valid) out.valid++;
    else {
      const why = r.person.failed[0]!;
      out.notValid[why] = (out.notValid[why] ?? 0) + 1;
    }
  }
  return out;
}

export function addCounts(a: PopulationCounts, b: PopulationCounts): PopulationCounts {
  const notValid = { ...a.notValid };
  for (const [k, n] of Object.entries(b.notValid)) notValid[k] = (notValid[k] ?? 0) + n;
  return { all: a.all + b.all, valid: a.valid + b.valid, notValid };
}

/** validOnly = keep accounts passing the saved filter; otherwise every account in scope. */
export function selectPopulation(records: EnrolmentRecord[], validOnly: boolean): EnrolmentRecord[] {
  return validOnly ? records.filter((r) => r.person.valid) : records;
}

/** One account's enrolment in one course. */
export function enrolmentKey(r: EnrolmentRecord): string {
  return `u:${r.person.userId}:${r.course.id}`;
}
