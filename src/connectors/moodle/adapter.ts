import { TtlCache } from "@/core/cache";
import { mapLimit } from "@/core/concurrency";
import type { MoodleSettings } from "@/core/env";
import type {
  AccountProfile,
  Category,
  Course,
  Enrolment,
  LearningDataPort,
  PersonCourse,
  PersonGrades,
  PersonRecord,
  SourceCapabilities,
} from "@/ports/learning";
import { MoodleClient } from "./client";
import type { RawCustomFields } from "./schemas";
import {
  categoriesSchema,
  coursesByFieldSchema,
  enrolledUsersSchema,
  gradeItemsSchema,
  siteInfoSchema,
  usersByFieldSchema,
  usersCoursesSchema,
} from "./schemas";

/**
 * Moodle implementation of LearningDataPort using ONLY core read functions
 * (docs/MOODLE_SETUP.md lists the exact service function set).
 *
 * Two-pass pull (performance): course enrolments are fetched WITHOUT profile fields —
 * building custom fields is the expensive part of core_enrol_get_enrolled_users — and each
 * person's profile is fetched once (batched by user id) and reused across courses.
 */

export interface MoodleAdapterOptions {
  settings: MoodleSettings;
  pageSize: number;
  cacheTtlSeconds: number;
  concurrency: number;
  fetchImpl?: typeof fetch;
}

/** Fields requested per enrolment — no custom fields, no email/phone/address. */
const ENROLMENT_FIELDS = "id,username,firstname,lastname,roles,lastaccess,lastcourseaccess";
const PROFILE_BATCH = 100;
const GRADES_FUNCTION = "gradereport_user_get_grade_items";

export class MoodleLearningAdapter implements LearningDataPort {
  readonly source = "moodle";
  private readonly client: MoodleClient;
  private readonly cache: TtlCache;

  constructor(private readonly opts: MoodleAdapterOptions) {
    this.client = new MoodleClient({ ...opts.settings, fetchImpl: opts.fetchImpl });
    this.cache = new TtlCache(opts.cacheTtlSeconds * 1000);
  }

  capabilities(): Promise<SourceCapabilities> {
    return this.cache.getOrLoad("capabilities", async () => {
      const info = await this.client.call("core_webservice_get_site_info", {}, siteInfoSchema);
      const fns = new Set((info.functions ?? []).map((f) => f.name));
      return { grades: fns.has(GRADES_FUNCTION) };
    });
  }

  listCategories(): Promise<Category[]> {
    return this.cache.getOrLoad("categories", async () => {
      const rows = await this.client.call("core_course_get_categories", {}, categoriesSchema);
      return rows.map((r) => ({
        id: r.id,
        name: text(r.name),
        parentId: r.parent,
        pathIds: r.path.split("/").filter(Boolean).map(Number),
      }));
    });
  }

  listCourses(): Promise<Course[]> {
    return this.cache.getOrLoad("courses", async () => {
      // No field/value = every course the service account can see.
      const res = await this.client.call("core_course_get_courses_by_field", {}, coursesByFieldSchema);
      return res.courses
        .filter((c) => c.id !== 1) // site front page
        .map((c) => ({
          id: c.id,
          shortName: text(c.shortname),
          fullName: text(c.fullname),
          categoryId: c.categoryid,
          visible: c.visible === undefined || c.visible === null ? true : c.visible === 1,
          // Only disclosed to accounts that may update the course: absent = unknown, not "off".
          completionEnabled:
            c.enablecompletion === undefined || c.enablecompletion === null ? null : c.enablecompletion === 1,
          startDate: positiveOrNull(c.startdate),
          endDate: positiveOrNull(c.enddate),
        }));
    });
  }

  /** Assembled from the (cached) pages; not cached again as a whole, to avoid holding it twice. */
  async listCourseEnrolments(courseId: number): Promise<Enrolment[]> {
    const out: Enrolment[] = [];
    for (let from = 0; ; from += this.opts.pageSize) {
      const page = await this.listCourseEnrolmentsPage(courseId, from, this.opts.pageSize);
      out.push(...page.rows);
      if (page.done) break;
    }
    return out;
  }

  listCourseEnrolmentsPage(
    courseId: number,
    offset: number,
    limit: number,
  ): Promise<{ rows: Enrolment[]; done: boolean }> {
    return this.cache.getOrLoad(`enrolments:${courseId}:${offset}:${limit}`, async () => {
      const page = await this.client.call(
        "core_enrol_get_enrolled_users",
        {
          courseid: courseId,
          options: [
            { name: "onlyactive", value: 1 },
            { name: "userfields", value: ENROLMENT_FIELDS },
            { name: "limitfrom", value: offset },
            { name: "limitnumber", value: limit },
            { name: "sortby", value: "id" },
          ],
        },
        enrolledUsersSchema,
      );
      const rows = page.map((u) => {
        return {
          userId: u.id,
          username: u.username ?? "",
          firstName: text(u.firstname),
          lastName: text(u.lastname),
          courseRoles: (u.roles ?? []).map((r) => r.shortname),
          lastCourseAccess: positiveOrNull(u.lastcourseaccess),
          lastSiteAccess: positiveOrNull(u.lastaccess),
        };
      });
      return { rows, done: page.length < limit };
    });
  }

  async getProfiles(userIds: number[]): Promise<Map<number, AccountProfile>> {
    const out = new Map<number, AccountProfile>();
    const missing: number[] = [];
    for (const id of new Set(userIds)) {
      const hit = this.cache.peek<AccountProfile>(`profile:${id}`);
      if (hit) out.set(id, await hit);
      else missing.push(id);
    }
    const batches: number[][] = [];
    for (let i = 0; i < missing.length; i += PROFILE_BATCH) batches.push(missing.slice(i, i + PROFILE_BATCH));
    await mapLimit(batches, this.opts.concurrency, async (ids) => {
      const rows = await this.client.call(
        "core_user_get_users_by_field",
        { field: "id", values: ids },
        usersByFieldSchema,
      );
      for (const u of rows) {
        const profile = accountProfile(u);
        out.set(u.id, profile);
        this.cache.set(`profile:${u.id}`, Promise.resolve(profile));
      }
    });
    return out;
  }

  async findPersonByUsername(username: string): Promise<PersonRecord | null> {
    const rows = await this.client.call(
      "core_user_get_users_by_field",
      { field: "username", values: [username.toLowerCase()] },
      usersByFieldSchema,
    );
    const u = rows[0];
    if (!u) return null;
    return {
      userId: u.id,
      username: u.username ?? username,
      firstName: text(u.firstname),
      lastName: text(u.lastname),
      ...accountProfile(u),
      lastSiteAccess: positiveOrNull(u.lastaccess),
    };
  }

  listPersonCourses(userId: number): Promise<PersonCourse[]> {
    return this.cache.getOrLoad(`personcourses:${userId}`, async () => {
      const rows = await this.client.call(
        "core_enrol_get_users_courses",
        { userid: userId },
        usersCoursesSchema,
      );
      return rows.map((c) => ({
        courseId: c.id,
        fullName: text(c.fullname),
        lastAccess: positiveOrNull(c.lastaccess),
        progressPct:
          c.progress === undefined || c.progress === null ? null : Math.round(c.progress * 10) / 10,
        completed: c.completed ?? null,
        completionEnabled: Boolean(c.enablecompletion),
      }));
    });
  }

  getCourseGrades(courseId: number): Promise<PersonGrades[]> {
    return this.cache.getOrLoad(`grades:${courseId}`, async () => {
      const res = await this.client.call(GRADES_FUNCTION, { courseid: courseId }, gradeItemsSchema);
      return res.usergrades.map((g) => ({
        userId: g.userid,
        items: g.gradeitems.map((i) => ({
          module: i.itemmodule ?? null,
          type: i.itemtype ?? "",
          raw: i.graderaw ?? null,
          max: i.grademax ?? null,
        })),
      }));
    });
  }
}

function accountProfile(u: {
  customfields?: RawCustomFields;
  email?: string | null | undefined;
  suspended?: boolean | number | null | undefined;
}): AccountProfile {
  return {
    fields: profileMap(u.customfields),
    emailDomain: emailDomain(u.email),
    suspended: u.suspended === undefined || u.suspended === null ? null : Boolean(u.suspended),
  };
}

/** "@domain" of an address, lower-cased; the local part is discarded here and never stored. */
export function emailDomain(email: string | null | undefined): string | null {
  const at = email?.lastIndexOf("@") ?? -1;
  if (!email || at < 0) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain ? `@${domain}` : null;
}

function profileMap(fields: RawCustomFields): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields ?? []) {
    if (f.value === undefined || f.value === null) continue;
    out[f.shortname] = text(String(f.value));
  }
  return out;
}

/**
 * Moodle web services return display strings through format_string(): HTML-escaped
 * ("Coffee &amp; Capsules") and sometimes padded. Return plain, single-spaced, trimmed text.
 */
export function text(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (m, n: string) => ENTITIES[n] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function positiveOrNull(v: number | null | undefined): number | null {
  return v && v > 0 ? v : null;
}
