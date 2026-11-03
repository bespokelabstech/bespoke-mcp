import { describe, expect, it } from "vitest";
import type { EnrolmentRecord } from "@/domain/access";
import { loadScope, summarize } from "@/domain/access";
import { toPersonView } from "@/domain/people";
import type { Course, PersonCourse } from "@/ports/learning";
import { FixtureLearningAdapter } from "@/connectors/fixture/adapter";
import { glaStaging, participant } from "./helpers";

const t = glaStaging();
const course = (id: number): Course => ({
  id,
  shortName: `C${id}`,
  fullName: `Course ${id}`,
  categoryId: 1,
  visible: true,
  completionEnabled: true,
  startDate: null,
  endDate: null,
});
const person = (id: number, region: string) =>
  toPersonView(participant({ userId: id, profile: { Region_Dropdown: region } }), t);

// Dealer 1 (MM): course A accessed at t=100, course B never.
// Dealer 2 (MM): never accessed either course.
// Dealer 3 (VIS): course A accessed at t=500.
const A = course(1),
  B = course(2);
const p1 = person(1, "Metro Manila"),
  p2 = person(2, "Metro Manila"),
  p3 = person(3, "Visayas");
const records: EnrolmentRecord[] = [
  { person: p1, course: A, lastCourseAccess: 100 },
  { person: p1, course: B, lastCourseAccess: null },
  { person: p2, course: A, lastCourseAccess: null },
  { person: p2, course: B, lastCourseAccess: null },
  { person: p3, course: A, lastCourseAccess: 500 },
];

describe("summarize", () => {
  it("count_by people: a person counts once; accessed = any in-scope course", () => {
    const rows = summarize(records, {
      groupBy: ["region"],
      countBy: "people",
      window: null,
      completion: null,
    });
    const mm = rows.find((r) => r.group.region === "Metro Manila")!;
    expect(mm).toMatchObject({ enrolled: 2, accessed: 1, never_accessed: 1, access_rate_pct: 50 });
  });

  it("count_by enrolments: each person-course pair counts", () => {
    const rows = summarize(records, {
      groupBy: ["region"],
      countBy: "enrolments",
      window: null,
      completion: null,
    });
    expect(rows.find((r) => r.group.region === "Metro Manila")).toMatchObject({
      enrolled: 4,
      accessed: 1,
      access_rate_pct: 25,
    });
  });

  it("group by course always counts enrolments and names the course", () => {
    const rows = summarize(records, {
      groupBy: ["course"],
      countBy: "people",
      window: null,
      completion: null,
    });
    expect(rows.find((r) => r.group.course?.id === 1)).toMatchObject({
      group: { course: { name: "Course 1" } },
      enrolled: 3,
      accessed: 2,
    });
  });

  it("window uses the most recent in-scope access per person", () => {
    const rows = summarize(records, {
      groupBy: [],
      countBy: "people",
      completion: null,
      window: { from: 200, to: null, semantics: "accessed_since", description: "" },
    });
    expect(rows[0]).toMatchObject({ enrolled: 3, accessed: 2, accessed_in_window: 1, window_rate_pct: 33.3 });
  });

  it("completion is enrolment-based over tracked enrolments only", () => {
    const completion = new Map<number, Map<number, PersonCourse>>([
      [
        1,
        new Map([
          [
            1,
            {
              courseId: 1,
              fullName: "",
              lastAccess: 100,
              progressPct: 100,
              completed: true,
              completionEnabled: true,
            },
          ],
          [
            2,
            {
              courseId: 2,
              fullName: "",
              lastAccess: null,
              progressPct: 0,
              completed: false,
              completionEnabled: true,
            },
          ],
        ]),
      ],
      [
        3,
        new Map([
          [
            1,
            {
              courseId: 1,
              fullName: "",
              lastAccess: 500,
              progressPct: null,
              completed: null,
              completionEnabled: true,
            },
          ],
        ]),
      ],
    ]);
    const [row] = summarize(records, { groupBy: [], countBy: "people", window: null, completion });
    expect(row!.completion).toEqual({
      basis: "enrolments",
      tracked_enrolments: 2,
      completed: 1,
      completion_rate_pct: 50,
      avg_progress_pct: 50,
    });
  });
});

describe("loadScope on synthetic data", () => {
  it("applies the dealer rule and reports exclusions", async () => {
    const port = new FixtureLearningAdapter({ nowSec: 1_800_000_000 });
    const scope = await loadScope(port, t, [port.courses[0]!], {});
    const ids = new Set(scope.records.map((r) => r.person.userId));
    expect(ids.has(9001)).toBe(false); // UAT pool
    expect(ids.has(9002)).toBe(false); // staff without Conso ID
    expect(ids.has(9003)).toBe(false); // redemptionmanager
    expect(ids.has(9004)).toBe(false); // teacher
    expect(scope.excluded).toMatchObject({
      excluded_username: 1,
      missing_identifier: 1,
      excluded_role: 1,
      missing_role: 1,
    });
  });

  it("filters by profile values", async () => {
    const port = new FixtureLearningAdapter({ nowSec: 1_800_000_000 });
    const scope = await loadScope(port, t, [port.courses[0]!], { region: ["Visayas"] });
    expect(scope.records.length).toBeGreaterThan(0);
    expect(scope.records.every((r) => r.person.region === "Visayas")).toBe(true);
  });
});
