/**
 * LearningDataPort — the capability boundary between business logic and any LMS.
 *
 * Domain services and tools depend ONLY on this interface. The Moodle connector is one
 * implementation; a fixture adapter is another (local dev / tests). A future LMS gets a
 * new adapter, not new business logic. Shapes here are system-neutral and contain only
 * the fields the business layer needs (data minimisation: no email, phone, address).
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
  completionEnabled: boolean;
  startDate: number | null; // epoch seconds
  endDate: number | null;
}

/** A person enrolled in a course, with the attributes metrics need. */
export interface Participant {
  userId: number;
  username: string;
  firstName: string;
  lastName: string;
  /** Course-level role shortnames in this course. */
  courseRoles: string[];
  /** Custom profile field shortname -> raw stored value. */
  profile: Record<string, string>;
  /** Last access to THIS course, epoch seconds; null if never. */
  lastCourseAccess: number | null;
}

/** A person looked up directly (not through a course). */
export interface PersonRecord {
  userId: number;
  username: string;
  firstName: string;
  lastName: string;
  profile: Record<string, string>;
  suspended: boolean | null;
}

/** One course enrolment of a person, with progress where the LMS exposes it. */
export interface PersonCourse {
  courseId: number;
  fullName: string;
  /** Last access to the course, epoch seconds; null if never or not visible to us. */
  lastAccess: number | null;
  /** 0..100, null when completion is not tracked or not visible to us. */
  progressPct: number | null;
  /** null when completion is not tracked or not visible to us. */
  completed: boolean | null;
  completionEnabled: boolean;
}

export interface LearningDataPort {
  /** Human-readable name of the backing system, for envelopes and logs. */
  readonly source: string;
  listCategories(): Promise<Category[]>;
  listCourses(): Promise<Course[]>;
  /** Active enrolments only. */
  listCourseParticipants(courseId: number): Promise<Participant[]>;
  findPersonByUsername(username: string): Promise<PersonRecord | null>;
  listPersonCourses(userId: number): Promise<PersonCourse[]>;
}
