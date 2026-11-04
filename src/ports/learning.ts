/**
 * LearningDataPort — the capability boundary between business logic and any LMS.
 *
 * Domain services and tools depend ONLY on this interface. The Moodle connector is one
 * implementation; a fixture adapter is another (local dev / tests). A future LMS — or the
 * same Moodle with a read-only reporting plugin — gets a new/extended adapter, not new
 * business logic. Shapes here are system-neutral and carry only what the business layer
 * needs (data minimisation: no email, phone, address).
 */

export interface Category {
  id: number;
  name: string;
  parentId: number;
  /** Ancestor ids from root to this category, inclusive. */
  pathIds: number[];
}

export interface Course {
  id: number;
  shortName: string;
  fullName: string;
  categoryId: number;
  visible: boolean;
  /** null = not disclosed to this account by the LMS (unknown — never treat as "off"). */
  completionEnabled: boolean | null;
  startDate: number | null; // epoch seconds
  endDate: number | null;
}

/** One active enrolment, WITHOUT profile fields (cheap to pull per course). */
export interface Enrolment {
  userId: number;
  username: string;
  firstName: string;
  lastName: string;
  /** Course-level role shortnames in this course. */
  courseRoles: string[];
  /** Last access to THIS course (epoch s). Web only on GLA: the mobile app does not update it. */
  lastCourseAccess: number | null;
  /** Last access to the site (epoch s), updated on app login and web use. */
  lastSiteAccess: number | null;
}

/** A person looked up directly (not through a course). */
export interface PersonRecord {
  userId: number;
  username: string;
  firstName: string;
  lastName: string;
  profile: Record<string, string>;
  suspended: boolean | null;
  lastSiteAccess: number | null;
}

/** One course enrolment of a person, with progress where the LMS exposes it. */
export interface PersonCourse {
  courseId: number;
  fullName: string;
  /** Last access to the course (web only on GLA); null if never or not visible. */
  lastAccess: number | null;
  /** 0..100, null when completion is not tracked or not visible to us. */
  progressPct: number | null;
  /** null when completion is not tracked or not visible to us. */
  completed: boolean | null;
  completionEnabled: boolean;
}

/** Graded items of one person in one course. */
export interface PersonGrades {
  userId: number;
  items: Array<{ module: string | null; type: string; raw: number | null; max: number | null }>;
}

export interface SourceCapabilities {
  /** Per-course grade report (Avg Score). */
  grades: boolean;
}

export interface LearningDataPort {
  /** Human-readable name of the backing system, for envelopes and logs. */
  readonly source: string;
  capabilities(): Promise<SourceCapabilities>;
  listCategories(): Promise<Category[]>;
  listCourses(): Promise<Course[]>;
  /** Active enrolments only, without profile fields. */
  listCourseEnrolments(courseId: number): Promise<Enrolment[]>;
  /** One page of active enrolments (stable order), for work split across calls. */
  listCourseEnrolmentsPage(
    courseId: number,
    offset: number,
    limit: number,
  ): Promise<{ rows: Enrolment[]; done: boolean }>;
  /** Custom profile fields (shortname -> raw value) for these users. Users not visible are omitted. */
  getProfiles(userIds: number[]): Promise<Map<number, Record<string, string>>>;
  findPersonByUsername(username: string): Promise<PersonRecord | null>;
  listPersonCourses(userId: number): Promise<PersonCourse[]>;
  /** Grades of every enrolled user in one course. Only when capabilities().grades. */
  getCourseGrades(courseId: number): Promise<PersonGrades[]>;
}
