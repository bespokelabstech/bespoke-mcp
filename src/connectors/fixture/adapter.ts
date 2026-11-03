import type {
  Category,
  Course,
  LearningDataPort,
  Participant,
  PersonCourse,
  PersonRecord,
} from "@/ports/learning";

/**
 * Deterministic SYNTHETIC data for local development and tests (MCP_DATA_SOURCE=fixture).
 * No real names or records. Refused on Vercel by the startup guardrails.
 *
 * Shapes mirror the GLA profile fields (level, Region_Dropdown, branch_code,
 * dealer_conso_id) including the awkward cases the metrics must handle:
 * empty values, legacy bare branch codes, junk branch values, UAT accounts,
 * staff without an identifier, and a non-student role.
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

export const FIXTURE_REGIONS = ["Metro Manila", "North Luzon", "South Luzon", "Visayas", "Mindanao"];
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

interface FixturePerson {
  userId: number;
  username: string;
  firstName: string;
  lastName: string;
  profile: Record<string, string>;
  role: string;
}

export class FixtureLearningAdapter implements LearningDataPort {
  readonly source = "fixture";
  readonly categories: Category[] = [
    { id: 2, name: "Onboarding", parentId: 0, pathIds: [2] },
    { id: 3, name: "Product Training", parentId: 0, pathIds: [3] },
    { id: 4, name: "Advanced", parentId: 3, pathIds: [3, 4] },
  ];
  readonly courses: Course[] = [
    {
      id: 10,
      shortName: "ONB101",
      fullName: "Welcome to Great Life",
      categoryId: 2,
      visible: true,
      completionEnabled: true,
      startDate: null,
      endDate: null,
    },
    {
      id: 11,
      shortName: "ONB102",
      fullName: "Business Basics",
      categoryId: 2,
      visible: true,
      completionEnabled: true,
      startDate: null,
      endDate: null,
    },
    {
      id: 20,
      shortName: "PRD201",
      fullName: "Product Knowledge",
      categoryId: 3,
      visible: true,
      completionEnabled: true,
      startDate: null,
      endDate: null,
    },
    {
      id: 21,
      shortName: "PRD202",
      fullName: "Selling Skills",
      categoryId: 3,
      visible: true,
      completionEnabled: false,
      startDate: null,
      endDate: null,
    },
    {
      id: 30,
      shortName: "ADV301",
      fullName: "Leadership",
      categoryId: 4,
      visible: true,
      completionEnabled: true,
      startDate: null,
      endDate: null,
    },
    {
      id: 40,
      shortName: "PRD-HIDDEN-CAT",
      fullName: "Coffee & Capsules",
      categoryId: 9, // not in `categories`: models a hidden category
      visible: true,
      completionEnabled: null,
      startDate: null,
      endDate: null,
    },
    {
      id: 31,
      shortName: "HID",
      fullName: "Hidden Draft",
      categoryId: 4,
      visible: false,
      completionEnabled: true,
      startDate: null,
      endDate: null,
    },
  ];
  readonly people: FixturePerson[] = [];
  /** courseId -> userId -> lastCourseAccess */
  readonly access = new Map<number, Map<number, number | null>>();
  readonly progress = new Map<string, { progress: number; completed: boolean }>();

  constructor(private readonly opts: FixtureOptions) {
    const rand = rng(opts.seed ?? 42);
    const n = opts.people ?? 120;
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
    for (let i = 0; i < n; i++) {
      const userId = 1000 + i;
      const conso = `pc${String(100000000 + i).padStart(10, "0")}`.slice(0, 12);
      const profile: Record<string, string> = {
        dealer_conso_id: conso,
        level: i % 17 === 0 ? "" : pick(FIXTURE_LEVELS),
        Region_Dropdown: i % 13 === 0 ? "" : pick(FIXTURE_REGIONS),
        branch_code: i % 29 === 0 ? "0032" : i % 31 === 0 ? "11111111111" : pick(FIXTURE_BRANCHES),
      };
      this.people.push({
        userId,
        username: conso,
        firstName: `Dealer`,
        lastName: `${String(i).padStart(3, "0")}`,
        profile,
        role: "student",
      });
    }
    // Edge cases.
    this.people.push({
      userId: 9001,
      username: "111111111125",
      firstName: "UAT",
      lastName: "Tester 06",
      profile: {
        dealer_conso_id: "111111111125",
        level: "Great Life Manager",
        Region_Dropdown: "Metro Manila",
        branch_code: "11111111111",
      },
      role: "student",
    });
    this.people.push({
      userId: 9002,
      username: "staff.jdoe",
      firstName: "Staff",
      lastName: "Member",
      profile: {},
      role: "student",
    });
    this.people.push({
      userId: 9003,
      username: "pcmanager001",
      firstName: "Branch",
      lastName: "Manager",
      profile: { dealer_conso_id: "pcmanager001" },
      role: "redemptionmanager",
    });
    this.people.push({
      userId: 9004,
      username: "teacher01",
      firstName: "Course",
      lastName: "Teacher",
      profile: {},
      role: "editingteacher",
    });

    for (const c of this.courses) {
      const m = new Map<number, number | null>();
      for (const p of this.people) {
        if (rand() < 0.15 && p.userId < 9000) continue; // not enrolled
        const r = rand();
        const last = r < 0.3 ? null : opts.nowSec - Math.floor(rand() * 120 * DAY);
        m.set(p.userId, last);
        const prog = last === null ? 0 : Math.round(rand() * 100);
        this.progress.set(`${p.userId}:${c.id}`, {
          progress: prog,
          completed: prog === 100 || (prog > 80 && rand() < 0.5),
        });
      }
      this.access.set(c.id, m);
    }
  }

  async listCategories(): Promise<Category[]> {
    return this.categories;
  }

  async listCourses(): Promise<Course[]> {
    return this.courses;
  }

  async listCourseParticipants(courseId: number): Promise<Participant[]> {
    const m = this.access.get(courseId) ?? new Map();
    return this.people
      .filter((p) => m.has(p.userId))
      .map((p) => ({
        userId: p.userId,
        username: p.username,
        firstName: p.firstName,
        lastName: p.lastName,
        courseRoles: [p.role],
        profile: p.profile,
        lastCourseAccess: m.get(p.userId) ?? null,
      }));
  }

  async findPersonByUsername(username: string): Promise<PersonRecord | null> {
    const p = this.people.find((x) => x.username === username.toLowerCase());
    return p
      ? {
          userId: p.userId,
          username: p.username,
          firstName: p.firstName,
          lastName: p.lastName,
          profile: p.profile,
          suspended: false,
        }
      : null;
  }

  async listPersonCourses(userId: number): Promise<PersonCourse[]> {
    return this.courses
      .filter((c) => this.access.get(c.id)?.has(userId))
      .map((c) => {
        const pr = this.progress.get(`${userId}:${c.id}`);
        return {
          courseId: c.id,
          fullName: c.fullName,
          lastAccess: this.access.get(c.id)?.get(userId) ?? null,
          progressPct: c.completionEnabled ? (pr?.progress ?? null) : null,
          completed: c.completionEnabled ? (pr?.completed ?? null) : null,
          completionEnabled: c.completionEnabled === true,
        };
      });
  }
}
