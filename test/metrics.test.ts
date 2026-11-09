import { describe, expect, it } from "vitest";
import { aggregate, finalize, mergePartials, sortMetricRows } from "@/domain/metrics";
import { classify, NO_FILTERS } from "@/domain/people";
import type { EnrolmentRecord } from "@/domain/population";
import { loadScope, populationCounts, selectPopulation } from "@/domain/population";
import { EDGE, FixtureLearningAdapter } from "@/connectors/fixture/adapter";
import type { Course, PersonCourse } from "@/ports/learning";
import { account, glaStaging } from "./helpers";

const t = glaStaging();
const course = (id: number): Course => ({
  id,
  shortName: `C${id}`,
  fullName: `Course ${id}`,
  categoryId: id === 1 ? 5 : 6,
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

// Dealer A (Visayas 1) has TWO accounts (same Conso ID, one with a dropped zero): they count separately.
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
const pc = (courseId: number, progressPct: number, completed: boolean): PersonCourse => ({
  courseId,
  fullName: "",
  lastAccess: null,
  progressPct,
  completed,
  completionEnabled: true,
});

describe("aggregate", () => {
  it("accounts: every account counts on its own (no merging); sign-in is per account", () => {
    const rows = aggregate(records, { ...base, groupBy: ["region"], unit: "accounts" });
    const vis = rows.find((r) => r.group.region === "Visayas 1")!;
    expect(vis.enrolled).toBe(3); // a1, a2 and b
    expect(vis.login_ever).toBe(1);
    expect(vis.web_ever).toBe(1);
    expect(vis.enrolments).toBe(5);
  });

  it("enrolments: each account-course enrolment (additive across parts)", () => {
    const [tot] = aggregate(records, { ...base, groupBy: [], unit: "enrolments" });
    expect(tot!.enrolled).toBe(6);
  });

  it("accessed, access rate, progress and avg. completion (÷ enrolled)", () => {
    const personCourses = new Map([
      [
        1,
        new Map([
          [1, pc(1, 25, false)],
          [2, pc(2, 100, true)],
        ]),
      ],
      [2, new Map([[1, pc(1, 0, false)]])],
      [
        3,
        new Map([
          [1, pc(1, 0, false)],
          [2, pc(2, 0, false)],
        ]),
      ],
      [
        4,
        new Map([[1, { ...pc(1, 0, false), completionEnabled: false, progressPct: null, completed: null }]]),
      ],
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
    const [row] = aggregate(records, { ...base, personCourses, scores, groupBy: [], unit: "accounts" });
    const out = finalize(row!, ["accessed", "logged_in", "progress", "avg_score"], false, false);
    expect(out.logged_in).toEqual({ count: 2, pct_of_enrolled: 50 });
    // accessed: a1 only; logged in: a1 and c → access rate 1 / 2
    expect(out.accessed).toEqual({ count: 1, access_rate_pct: 50, unknown: 0 });
    // 6 enrolments, 1 completed; c's course has no completion tracking
    expect(out.progress).toMatchObject({
      enrolments: 6,
      completed: 1,
      avg_completion_pct: 16.7,
      untracked_enrolments: 1,
    });
    expect(out.progress!.avg_progress_pct).toBe(25);
    expect(out.avg_score).toEqual({ graded_items: 2, avg_score_pct: 70 });
  });

  it("with a date range, Logged in is windowed and the access rate is not computed", () => {
    const personCourses = new Map([[1, new Map([[1, pc(1, 25, false)]])]]);
    const [row] = aggregate(records, {
      ...base,
      personCourses,
      groupBy: [],
      unit: "accounts",
      window: { from: 600, to: null, semantics: "accessed_since", description: "" },
    });
    const out = finalize(row!, ["logged_in", "accessed"], true, false);
    expect(out.logged_in).toEqual({ count: 1, pct_of_enrolled: 25, ever: 2 });
    expect(out.accessed!.access_rate_pct).toBeNull();
  });

  it("partials from disjoint courses add up to the whole", () => {
    const opts = { ...base, groupBy: ["region" as const], unit: "enrolments" as const };
    const whole = aggregate(records, opts);
    const p1 = aggregate(
      records.filter((r) => r.course.id === 1),
      opts,
    );
    const p2 = aggregate(
      records.filter((r) => r.course.id === 2),
      opts,
    );
    const key = (r: { group: unknown }) => JSON.stringify(r.group);
    expect(new Map(mergePartials(p1, p2).map((r) => [key(r), r]))).toEqual(
      new Map(whole.map((r) => [key(r), r])),
    );
  });

  it("groups by category", () => {
    const rows = aggregate(records, {
      ...base,
      groupBy: ["category"],
      unit: "accounts",
      categoryNames: new Map([[5, "Onboarding"]]),
    });
    expect(rows.map((r) => r.group.category).sort((x, y) => x!.id - y!.id)).toEqual([
      { id: 5, name: "Onboarding" },
      { id: 6, name: null },
    ]);
  });
});

describe("sortMetricRows", () => {
  const rows = aggregate(records, { ...base, groupBy: ["region"], unit: "accounts" }).map((r) =>
    finalize(r, ["logged_in"], false),
  );
  it("sorts on any column in either direction, nulls last", () => {
    expect(sortMetricRows(rows, "-enrolled").map((r) => r.group!.region)).toEqual([
      "Visayas 1",
      "Mega Manila",
    ]);
    expect(sortMetricRows(rows, "enrolled").map((r) => r.group!.region)).toEqual([
      "Mega Manila",
      "Visayas 1",
    ]);
    expect(sortMetricRows(rows, "-logged_in_pct").map((r) => r.group!.region)).toEqual([
      "Mega Manila",
      "Visayas 1",
    ]);
    expect(sortMetricRows(rows, "group").map((r) => r.group!.region)).toEqual(["Mega Manila", "Visayas 1"]);
  });
});

describe("loadScope on synthetic data", () => {
  it("applies the base scope and marks accounts failing the saved filter", async () => {
    const port = new FixtureLearningAdapter({ nowSec: 1_800_000_000 });
    const { records: all } = await loadScope(port, t, [port.courses[0]!], NO_FILTERS);
    const byUser = new Map(all.map((r) => [r.person.userId, r.person]));
    expect(byUser.has(EDGE.teacher)).toBe(false);
    expect(byUser.has(EDGE.manager)).toBe(false);
    for (const id of [
      EDGE.dealerAlnum,
      EDGE.dupDropped0,
      EDGE.legacyNone,
      EDGE.legacyFb,
      EDGE.legacyNl,
      EDGE.staff,
    ]) {
      expect(byUser.get(id)!.valid).toBe(true);
    }
    expect(byUser.get(EDGE.dummyRepeat)!.failed).toEqual(["Dummy Conso ID"]);
    expect(byUser.get(EDGE.dummyOnes)!.failed).toEqual(["Dummy Conso ID"]); // username "admin.user"
    expect(byUser.get(EDGE.uat)!.failed).toEqual(["Dummy Conso ID", "Dummy username"]);
    const counts = populationCounts(all, "accounts");
    expect(counts.all - counts.valid).toBe(3);
    expect(counts.notValid).toEqual({ "Dummy Conso ID": 3 });
    expect(selectPopulation(all, true).length).toBe(counts.valid);
  });
});
