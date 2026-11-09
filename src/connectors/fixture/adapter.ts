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

/**
 * Deterministic SYNTHETIC data for local development and tests (MCP_DATA_SOURCE=fixture).
 * No real names or records. Refused on Vercel by the startup guardrails.
 *
 * Mirrors what was sampled on GLA staging (patterns only): canonical Conso IDs
 * (branch code + 8 digits), PC alphanumeric IDs, an 11-digit ID with a dropped leading zero
 * (a second account of the same dealer), legacy formats, staff at "PC Center of Excellence",
 * dummy IDs, the UAT test series, non-learner roles, region "families" (Visayas vs Visayas 1/2),
 * web course access that the app never updates, and site access that it does.
 */

const DAY = 86_400;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export interface FixtureOptions {
  nowSec: number;
  people?: number;
  seed?: number;
}

export const FIXTURE_REGIONS = [
  "Mega Manila",
  "North Luzon",
  "Visayas",
  "Visayas 1",
  "Visayas 2",
  "Mindanao 3",
];
export const FIXTURE_LEVELS = [
  "Great Life Builder",
  "Great Life Manager",
  "Great Life Director",
  "Great Life Executive",
];
export const FIXTURE_BRANCHES = [
  "QUEZON AVE (0032)",
  "CUBAO (0101)",
  "BAGUIO (0210)",
  "BATANGAS (0330)",
  "CEBU MAIN (0450)",
  "DAVAO (0575c)",
];

export interface FixturePerson {
  userId: number;
  username: string;
  firstName: string;
  lastName: string;
  profile: Record<string, string>;
  emailDomain: string | null;
  suspended: boolean;
  role: string;
  lastSiteAccess: number | null;
}

/** Edge-case accounts with fixed ids, used by tests. */
export const EDGE = {
  dealerAlnum: 9001, // alphanumeric Conso ID — valid
  dupDropped0: 9002, // 11-digit second account of dealer 1000 — valid, counts separately
  legacyNone: 9003, // no Conso ID, non-Conso username — valid (no rule rejects it)
  legacyFb: 9004, // "fb 007700901" — valid
  legacyNl: 9005, // "nl_0999_0007" — valid
  staff: 9006, // PC Center of Excellence, 4-digit id — valid, dropped by the default level exclude
  dummyRepeat: 9007, // username "aimon.test" — hidden (test username)
  dummyOnes: 9008, // username "admin.user" — hidden (admin username)
  uat: 9009, // username 111111111125 (staging UAT range) — hidden (dummy Conso ID)
  teacher: 9010, // editingteacher role — outside the base scope
  manager: 9011, // student + redemptionmanager roles — outside the base scope
  internalEmail: 9012, // @bihasa.ph email — hidden (internal email domain)
  suspended: 9013, // suspended account — hidden
  sampleName: 9014, // name "Sample Account" — hidden (test or dummy name)
  blankName: 9015, // blank name — hidden (placeholder name)
  legacyName: 9016, // name starting with a legacy username — hidden (placeholder name)
} as const;

export class FixtureLearningAdapter implements LearningDataPort {
  readonly source = "fixture";
  readonly categories: Category[] = [
    { id: 2, name: "Onboarding", parentId: 0, pathIds: [2] },
    { id: 3, name: "Product Training", parentId: 0, pathIds: [3] },
    { id: 4, name: "Advanced", parentId: 3, pathIds: [3, 4] },
  ];
  readonly courses: Course[] = [
    course(10, "ONB101", "Welcome to Great Life", 2, true),
    course(11, "ONB102", "Business Basics", 2, true),
    course(20, "PRD201", "Product Knowledge", 3, true),
    course(21, "PRD202", "Selling Skills", 3, false),
    course(30, "ADV301", "Leadership", 4, true),
    // A visible course inside a category the service account cannot see (as on staging).
    { ...course(40, "PRD-HIDDEN-CAT", "Coffee & Capsules", 9, true), completionEnabled: null },
    { ...course(31, "HID", "Hidden Draft", 4, true), visible: false },
  ];
  readonly people: FixturePerson[] = [];
  /** courseId -> userId -> lastCourseAccess (web only) */
  readonly access = new Map<number, Map<number, number | null>>();
  readonly progress = new Map<string, { progress: number; completed: boolean; score: number | null }>();

  constructor(private readonly opts: FixtureOptions) {
    const rand = rng(opts.seed ?? 42);
    const n = opts.people ?? 120;
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const site = () => (rand() < 0.25 ? null : opts.nowSec - Math.floor(rand() * 120 * DAY));

    for (let i = 0; i < n; i++) {
      const branch = i % 29 === 0 ? "0032" : pick(FIXTURE_BRANCHES);
      const code = /\((\d{4})/.exec(branch)?.[1] ?? "0032";
      const conso = `${code}${String(10_000_000 + i).slice(-8)}`;
      this.people.push({
        userId: 1000 + i,
        username: conso,
        firstName: "Dealer",
        lastName: String(i).padStart(3, "0"),
        profile: {
          dealer_conso_id: conso,
          level: i % 17 === 0 ? "" : pick(FIXTURE_LEVELS),
          Region_Dropdown: i % 13 === 0 ? "" : pick(FIXTURE_REGIONS),
          branch_code: branch,
        },
        emailDomain: "@example.com",
        suspended: false,
        role: "student",
        lastSiteAccess: site(),
      });
    }
    const first = this.people[0]!;
    const edge = (
      userId: number,
      username: string,
      profile: Record<string, string>,
      role = "student",
      over: Partial<FixturePerson> = {},
    ): void => {
      this.people.push({
        userId,
        username,
        firstName: "Edge",
        lastName: String(userId),
        profile: {
          level: "Great Life Manager",
          Region_Dropdown: "Mega Manila",
          branch_code: "CUBAO (0101)",
          ...profile,
        },
        emailDomain: "@example.com",
        suspended: false,
        role,
        lastSiteAccess: opts.nowSec - DAY,
        ...over,
      });
    };
    edge(EDGE.dealerAlnum, "500000j99901", { dealer_conso_id: "500000j99901" });
    edge(EDGE.dupDropped0, "dup.account", {
      ...first.profile,
      dealer_conso_id: first.username.replace(/^0/, ""),
    });
    edge(EDGE.legacyNone, "legacy.user", {});
    edge(EDGE.legacyFb, "fb.user", { dealer_conso_id: "fb 007700901" });
    edge(EDGE.legacyNl, "nl.user", { dealer_conso_id: "nl_0999_0007" });
    edge(EDGE.staff, "staff.4321", { dealer_conso_id: "4321", level: "PC Center of Excellence" });
    edge(EDGE.dummyRepeat, "aimon.test", { dealer_conso_id: "123123123123" });
    edge(EDGE.dummyOnes, "admin.user", { dealer_conso_id: "111111111111" });
    edge(EDGE.uat, "111111111125", { dealer_conso_id: "111111111125" });
    edge(EDGE.teacher, "teacher01", {}, "editingteacher");
    edge(EDGE.manager, "pcmanager001", { dealer_conso_id: "pcmanager01" }, "redemptionmanager");
    edge(EDGE.internalEmail, "ops.staff", {}, "student", { emailDomain: "@bihasa.ph" });
    edge(EDGE.suspended, "077700099990", { dealer_conso_id: "077700099990" }, "student", { suspended: true });
    edge(EDGE.sampleName, "077700099991", {}, "student", { firstName: "Sample", lastName: "Account" });
    edge(EDGE.blankName, "077700099992", {}, "student", { firstName: "", lastName: "" });
    edge(EDGE.legacyName, "cl.user", {}, "student", { firstName: "cl_0106_00003", lastName: "Dealer" });

    for (const c of this.courses) {
      const m = new Map<number, number | null>();
      for (const p of this.people) {
        if (rand() < 0.15 && p.userId < 9000) continue; // not enrolled
        // Web course access is rare (the app never updates it).
        m.set(p.userId, rand() < 0.08 ? opts.nowSec - Math.floor(rand() * 90 * DAY) : null);
        const prog = rand() < 0.4 ? 0 : Math.round(rand() * 100);
        const completed = prog === 100 || (prog > 80 && rand() < 0.5);
        this.progress.set(`${p.userId}:${c.id}`, {
          progress: prog,
          completed,
          score: prog > 0 ? Math.round(40 + rand() * 60) : null,
        });
      }
      this.access.set(c.id, m);
    }
  }

  async capabilities(): Promise<SourceCapabilities> {
    return { grades: true };
  }

  async listCategories(): Promise<Category[]> {
    return this.categories;
  }

  async listCourses(): Promise<Course[]> {
    return this.courses;
  }

  async listCourseEnrolments(courseId: number): Promise<Enrolment[]> {
    const m = this.access.get(courseId) ?? new Map();
    return this.people
      .filter((p) => m.has(p.userId))
      .map((p) => ({
        userId: p.userId,
        username: p.username,
        firstName: p.firstName,
        lastName: p.lastName,
        nameShown: true,
        courseRoles: p.role === "redemptionmanager" ? ["student", p.role] : [p.role],
        lastCourseAccess: m.get(p.userId) ?? null,
        lastSiteAccess: p.lastSiteAccess,
      }));
  }

  async listCourseEnrolmentsPage(
    courseId: number,
    offset: number,
    limit: number,
  ): Promise<{ rows: Enrolment[]; done: boolean }> {
    const all = await this.listCourseEnrolments(courseId);
    const rows = all.slice(offset, offset + limit);
    return { rows, done: offset + limit >= all.length };
  }

  async getProfiles(userIds: number[]): Promise<Map<number, AccountProfile>> {
    const want = new Set(userIds);
    return new Map(
      this.people
        .filter((p) => want.has(p.userId))
        .map((p) => [p.userId, { fields: p.profile, emailDomain: p.emailDomain, suspended: p.suspended }]),
    );
  }

  async findPersonByUsername(username: string): Promise<PersonRecord | null> {
    const p = this.people.find((x) => x.username === username.toLowerCase());
    return p
      ? {
          userId: p.userId,
          username: p.username,
          firstName: p.firstName,
          lastName: p.lastName,
          fields: p.profile,
          emailDomain: p.emailDomain,
          suspended: p.suspended,
          lastSiteAccess: p.lastSiteAccess,
        }
      : null;
  }

  async listPersonCourses(userId: number): Promise<PersonCourse[]> {
    return this.courses
      .filter((c) => this.access.get(c.id)?.has(userId))
      .map((c) => {
        const pr = this.progress.get(`${userId}:${c.id}`);
        const tracked = c.completionEnabled === true;
        return {
          courseId: c.id,
          fullName: c.fullName,
          lastAccess: this.access.get(c.id)?.get(userId) ?? null,
          progressPct: tracked ? (pr?.progress ?? null) : null,
          completed: tracked ? (pr?.completed ?? null) : null,
          completionEnabled: tracked,
        };
      });
  }

  async getCourseGrades(courseId: number): Promise<PersonGrades[]> {
    const m = this.access.get(courseId) ?? new Map();
    return [...m.keys()].map((userId) => {
      const score = this.progress.get(`${userId}:${courseId}`)?.score ?? null;
      return {
        userId,
        items: [
          { module: "quiz", type: "mod", raw: score, max: score === null ? null : 100 },
          { module: null, type: "course", raw: score, max: 100 },
        ],
      };
    });
  }
}

function course(
  id: number,
  shortName: string,
  fullName: string,
  categoryId: number,
  completion: boolean,
): Course {
  return {
    id,
    shortName,
    fullName,
    categoryId,
    visible: true,
    completionEnabled: completion,
    startDate: null,
    endDate: null,
  };
}
