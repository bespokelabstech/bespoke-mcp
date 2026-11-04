import { describe, expect, it } from "vitest";
import { aggregate, finalize, mergePartials } from "@/domain/metrics";
import { classify } from "@/domain/people";
import type { EnrolmentRecord } from "@/domain/population";
import { loadScope, selectPopulation, statusCounts } from "@/domain/population";
import { EDGE, FixtureLearningAdapter } from "@/connectors/fixture/adapter";
import type { Course, PersonCourse } from "@/ports/learning";
import { account, glaStaging } from "./helpers";

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
const person = (userId: number, conso: string, region: string) =>
  classify(
    account({ userId, username: `u${userId}`, profile: { dealer_conso_id: conso, Region_Dropdown: region } }),
    t,
  );
const rec = (
  p: ReturnType<typeof person>,
  c: Course,
  web: number | null,
  site: number | null,
): EnrolmentRecord => ({
  person: p,
  course: c,
  lastCourseAccess: web,
  lastSiteAccess: site,
});

// Dealer A (Visayas 1) has TWO accounts (same Conso ID, one with a dropped zero).
const A = course(1),
  B = course(2);
const a1 = person(1, "099900077574", "Visayas 1");
const a2 = person(2, "99900077574", "Visayas 1");
const b = person(3, "077700099283", "Visayas 1");
const c = person(4, "088800099158", "Mega Manila");
const records: EnrolmentRecord[] = [
  rec(a1, A, null, 500),
  rec(a2, A, 100, null),
  rec(a1, B, null, 500),
  rec(b, A, null, null),
  rec(b, B, null, null),
  rec(c, A, null, 900),
];
const base = { window: null, personCourses: null, scores: null };

describe("aggregate", () => {
  it("people: duplicate accounts merge; access = most recent across accounts and courses", () => {
    const rows = aggregate(records, { ...base, groupBy: ["region"], unit: "people" });
    const vis = rows.find((r) => r.group.region === "Visayas 1")!;
    expect(vis.enrolled).toBe(2); // dealer A + dealer b, not 3 accounts
    expect(vis.site_ever).toBe(1);
    expect(vis.web_ever).toBe(1);
  });

  it("enrolments: each dealer-course pair once (duplicates within a course merge)", () => {
    const [tot] = aggregate(records, { ...base, groupBy: [], unit: "enrolments" });
    expect(tot!.enrolled).toBe(5); // A×course1, A×course2, b×1, b×2, c×1
  });

  it("started = progress > 0 or completed; completion and score are enrolment-based", () => {
    const pc = (courseId: number, progressPct: number, completed: boolean): PersonCourse => ({
      courseId,
      fullName: "",
      lastAccess: null,
      progressPct,
      completed,
      completionEnabled: true,
    });
    const personCourses = new Map([
      [
        1,
        new Map([
          [1, pc(1, 25, false)],
          [2, pc(2, 100, true)],
        ]),
      ],
      [
        3,
        new Map([
          [1, pc(1, 0, false)],
          [2, pc(2, 0, false)],
        ]),
      ],
      [4, new Map([[1, pc(1, 0, false)]])],
    ]);
    const scores = new Map([
      [
        1,
        new Map([
          [1, [80]],
          [4, [60]],
        ]),
      ],
    ]);
    const [row] = aggregate(records, { ...base, personCourses, scores, groupBy: [], unit: "people" });
    const out = finalize(row!, ["started", "completion", "avg_score"], false, false);
    expect(out.started).toEqual({ count: 1, rate_pct: 33.3, unknown: 0 });
    // tracked: a×1 (the duplicate account adds nothing), a×2, b×1, b×2, c×1
    expect(out.completion).toMatchObject({ tracked_enrolments: 5, completed: 1, completion_rate_pct: 20 });
    expect(out.avg_score).toEqual({ graded_items: 2, avg_score_pct: 70 });
  });

  it("partials from disjoint courses add up to the whole", () => {
    const whole = aggregate(records, { ...base, groupBy: ["region"], unit: "enrolments" });
    const p1 = aggregate(
      records.filter((r) => r.course.id === 1),
      { ...base, groupBy: ["region"], unit: "enrolments" },
    );
    const p2 = aggregate(
      records.filter((r) => r.course.id === 2),
      { ...base, groupBy: ["region"], unit: "enrolments" },
    );
    const merged = mergePartials(p1, p2);
    const key = (r: { group: unknown }) => JSON.stringify(r.group);
    expect(new Map(merged.map((r) => [key(r), r]))).toEqual(new Map(whole.map((r) => [key(r), r])));
  });

  it("windows count the most recent access", () => {
    const [row] = aggregate(records, {
      ...base,
      groupBy: [],
      unit: "people",
      window: { from: 600, to: null, semantics: "accessed_since", description: "" },
    });
    expect(finalize(row!, ["site_last_access"], true, false).site_last_access).toEqual({
      ever: 2,
      in_window: 1,
      window_rate_pct: 33.3,
    });
  });
});

describe("loadScope on synthetic data", () => {
  it("assigns every edge account the expected status", async () => {
    const port = new FixtureLearningAdapter({ nowSec: 1_800_000_000 });
    const { records: all } = await loadScope(port, t, [port.courses[0]!], {});
    const byUser = new Map(
      all.map((r) => [r.person.userId, `${r.person.status}${r.person.reason ? `:${r.person.reason}` : ""}`]),
    );
    expect(byUser.get(EDGE.dealerAlnum)).toBe("person");
    expect(byUser.get(EDGE.dupDropped0)).toBe("person");
    expect(byUser.get(EDGE.legacyNone)).toBe("legacy");
    expect(byUser.get(EDGE.legacyFb)).toBe("legacy");
    expect(byUser.get(EDGE.legacyNl)).toBe("legacy");
    expect(byUser.get(EDGE.staff)).toBe("excluded:staff");
    expect(byUser.get(EDGE.dummyRepeat)).toBe("excluded:dummy");
    expect(byUser.get(EDGE.dummyOnes)).toBe("excluded:dummy");
    expect(byUser.get(EDGE.uat)).toBe("excluded:test");
    expect(byUser.get(EDGE.teacher)).toBe("excluded:role");
    expect(byUser.get(EDGE.manager)).toBe("excluded:role");
    const counts = statusCounts(all, "people");
    expect(counts.legacy).toBe(3);
    expect(counts.excluded).toBe(6);
    // the duplicate account merges into its dealer
    const dealers = selectPopulation(all, ["person"]);
    expect(new Set(dealers.map((r) => r.person.key)).size).toBe(counts.person);
    const originalEnrolled = all.some((r) => r.person.userId === 1000);
    expect(dealers.length).toBe(counts.person + (originalEnrolled ? 1 : 0));
  });
});
