import { TtlCache } from "@/core/cache";
import type { MoodleSettings } from "@/core/env";
import type {
  Category,
  Course,
  LearningDataPort,
  Participant,
  PersonCourse,
  PersonRecord,
} from "@/ports/learning";
import { MoodleClient } from "./client";
import type { RawCustomFields } from "./schemas";
import {
  categoriesSchema,
  coursesByFieldSchema,
  enrolledUsersSchema,
  usersByFieldSchema,
  usersCoursesSchema,
} from "./schemas";

/**
 * Moodle implementation of LearningDataPort using ONLY core read functions
 * (docs/MOODLE_SETUP.md lists the exact service function set):
 *   core_course_get_categories, core_course_get_courses_by_field,
 *   core_enrol_get_enrolled_users, core_user_get_users_by_field, core_enrol_get_users_courses.
 */

export interface MoodleAdapterOptions {
  settings: MoodleSettings;
  pageSize: number;
  cacheTtlSeconds: number;
  fetchImpl?: typeof fetch;
}

/** Fields requested from core_enrol_get_enrolled_users — no email/phone/address. */
const ENROLLED_USER_FIELDS = "id,username,firstname,lastname,roles,customfields,lastcourseaccess";

export class MoodleLearningAdapter implements LearningDataPort {
  readonly source = "moodle";
  private readonly client: MoodleClient;
  private readonly cache: TtlCache;

  constructor(private readonly opts: MoodleAdapterOptions) {
    this.client = new MoodleClient({ ...opts.settings, fetchImpl: opts.fetchImpl });
    this.cache = new TtlCache(opts.cacheTtlSeconds * 1000);
  }

  listCategories(): Promise<Category[]> {
    return this.cache.getOrLoad("categories", async () => {
      const rows = await this.client.call("core_course_get_categories", {}, categoriesSchema);
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
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
          shortName: c.shortname,
          fullName: c.fullname,
          categoryId: c.categoryid,
          visible: c.visible === undefined || c.visible === null ? true : c.visible === 1,
          completionEnabled: c.enablecompletion === 1,
          startDate: positiveOrNull(c.startdate),
          endDate: positiveOrNull(c.enddate),
        }));
    });
  }

  listCourseParticipants(courseId: number): Promise<Participant[]> {
    return this.cache.getOrLoad(`participants:${courseId}`, async () => {
      const out: Participant[] = [];
      for (let from = 0; ; from += this.opts.pageSize) {
        const page = await this.client.call(
          "core_enrol_get_enrolled_users",
          {
            courseid: courseId,
            options: [
              { name: "onlyactive", value: 1 },
              { name: "userfields", value: ENROLLED_USER_FIELDS },
              { name: "limitfrom", value: from },
              { name: "limitnumber", value: this.opts.pageSize },
              { name: "sortby", value: "id" },
            ],
          },
          enrolledUsersSchema,
        );
        for (const u of page) {
          out.push({
            userId: u.id,
            username: u.username ?? "",
            firstName: u.firstname ?? "",
            lastName: u.lastname ?? "",
            courseRoles: (u.roles ?? []).map((r) => r.shortname),
            profile: profileMap(u.customfields),
            lastCourseAccess: positiveOrNull(u.lastcourseaccess),
          });
        }
        if (page.length < this.opts.pageSize) break;
      }
      return out;
    });
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
      firstName: u.firstname ?? "",
      lastName: u.lastname ?? "",
      profile: profileMap(u.customfields),
      suspended: u.suspended === undefined || u.suspended === null ? null : Boolean(u.suspended),
    };
  }

  async listPersonCourses(userId: number): Promise<PersonCourse[]> {
    const rows = await this.client.call(
      "core_enrol_get_users_courses",
      { userid: userId },
      usersCoursesSchema,
    );
    return rows.map((c) => ({
      courseId: c.id,
      fullName: c.fullname,
      lastAccess: positiveOrNull(c.lastaccess),
      progressPct: c.progress === undefined || c.progress === null ? null : Math.round(c.progress * 10) / 10,
      completed: c.completed ?? null,
      completionEnabled: Boolean(c.enablecompletion),
    }));
  }
}

function profileMap(fields: RawCustomFields): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields ?? []) {
    if (f.value === undefined || f.value === null) continue;
    out[f.shortname] = String(f.value).trim();
  }
  return out;
}

function positiveOrNull(v: number | null | undefined): number | null {
  return v && v > 0 ? v : null;
}
