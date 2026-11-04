import { describe, expect, it, vi } from "vitest";
import { flattenParams, MoodleClient } from "@/connectors/moodle/client";
import { MoodleLearningAdapter } from "@/connectors/moodle/adapter";
import { enrolledUsersSchema } from "@/connectors/moodle/schemas";

const SECRET = "ws-token-secret";

function fakeFetch(responses: Array<{ status?: number; body: unknown } | Error>) {
  const calls: Array<{ url: string; body: string }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body) });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const client = (f: typeof fetch) =>
  new MoodleClient({ baseUrl: "https://lms.example", token: SECRET, timeoutMs: 2000, fetchImpl: f });

describe("flattenParams", () => {
  it("encodes nested arrays PHP-style", () => {
    expect(
      flattenParams({ courseid: 5, options: [{ name: "onlyactive", value: 1 }], values: ["a"], flag: true }),
    ).toEqual([
      ["courseid", "5"],
      ["options[0][name]", "onlyactive"],
      ["options[0][value]", "1"],
      ["values[0]", "a"],
      ["flag", "1"],
    ]);
  });
});

describe("MoodleClient", () => {
  it("sends the token in the body, never in the URL", async () => {
    const f = fakeFetch([{ body: [] }]);
    await client(f.impl).call("core_enrol_get_enrolled_users", { courseid: 1 }, enrolledUsersSchema);
    expect(f.calls[0]!.url).toBe("https://lms.example/webservice/rest/server.php");
    expect(f.calls[0]!.url).not.toContain(SECRET);
    expect(f.calls[0]!.body).toContain(`wstoken=${SECRET}`);
    expect(f.calls[0]!.body).toContain("moodlewsrestformat=json");
  });

  it("maps Moodle permission exceptions to upstream_denied without echoing the message", async () => {
    const f = fakeFetch([
      { body: { exception: "x", errorcode: "nopermissions", message: `secret detail ${SECRET}` } },
    ]);
    const err = await client(f.impl)
      .call("core_enrol_get_enrolled_users", {}, enrolledUsersSchema)
      .catch((e) => e);
    expect(err.code).toBe("upstream_denied");
    expect(err.message).not.toContain(SECRET);
    expect(err.logFields.errorcode).toBe("nopermissions");
  });

  it("retries once on network failure / 5xx, not on application errors", async () => {
    const f = fakeFetch([new Error("ECONNRESET"), { body: [] }]);
    await expect(client(f.impl).call("f", {}, enrolledUsersSchema)).resolves.toEqual([]);
    const g = fakeFetch([
      { status: 503, body: {} },
      { status: 503, body: {} },
    ]);
    await expect(client(g.impl).call("f", {}, enrolledUsersSchema)).rejects.toMatchObject({
      code: "upstream_unavailable",
    });
    expect(g.calls).toHaveLength(2);
    const h = fakeFetch([{ body: { exception: "x", errorcode: "invalidrecord" } }]);
    await expect(client(h.impl).call("f", {}, enrolledUsersSchema)).rejects.toMatchObject({
      code: "upstream_error",
    });
    expect(h.calls).toHaveLength(1);
  });

  it("rejects unexpected shapes", async () => {
    const f = fakeFetch([{ body: { not: "an array" } }]);
    await expect(client(f.impl).call("f", {}, enrolledUsersSchema)).rejects.toMatchObject({
      code: "upstream_schema",
    });
  });
});

const adapterWith = (f: typeof fetch, pageSize = 100) =>
  new MoodleLearningAdapter({
    settings: { baseUrl: "https://lms.example", token: SECRET, timeoutMs: 2000 },
    pageSize,
    cacheTtlSeconds: 60,
    concurrency: 2,
    fetchImpl: f,
  });

describe("MoodleLearningAdapter", () => {
  it("pages enrolments WITHOUT requesting custom fields", async () => {
    const user = (id: number) => ({
      id,
      username: `u${id}`,
      firstname: "F",
      lastname: "L",
      email: "x@example.com",
      roles: [{ roleid: 5, shortname: "student" }],
      lastaccess: 1_700_000_100,
      lastcourseaccess: id === 2 ? 0 : 1_700_000_000,
    });
    const f = fakeFetch([{ body: [user(1), user(2)] }, { body: [user(3)] }]);
    const adapter = adapterWith(f.impl, 2);
    const rows = await adapter.listCourseEnrolments(7);
    expect(rows.map((p) => p.userId)).toEqual([1, 2, 3]);
    expect(rows[0]).toEqual({
      userId: 1,
      username: "u1",
      firstName: "F",
      lastName: "L",
      courseRoles: ["student"],
      lastCourseAccess: 1_700_000_000,
      lastSiteAccess: 1_700_000_100,
    });
    expect(rows[1]!.lastCourseAccess).toBeNull();
    const body = decodeURIComponent(f.calls[0]!.body);
    expect(body).toContain("onlyactive");
    expect(body).toContain("userfields");
    expect(body).not.toContain("customfields");
    expect(f.calls[1]!.body).toContain("options%5B2%5D%5Bvalue%5D=2"); // limitfrom=2 on page 2
    await adapter.listCourseEnrolments(7); // cached
    expect(f.calls).toHaveLength(2);
  });

  it("fetches each profile once, batched by user id, and reuses it", async () => {
    const f = fakeFetch([
      {
        body: [
          {
            id: 1,
            customfields: [
              { shortname: "level", value: "Great Life Builder" },
              { shortname: "branch_code", value: " CUBAO (0101) " },
            ],
          },
          { id: 2, customfields: [] },
        ],
      },
    ]);
    const adapter = adapterWith(f.impl);
    const first = await adapter.getProfiles([1, 2, 1]);
    expect(first.get(1)).toEqual({ level: "Great Life Builder", branch_code: "CUBAO (0101)" });
    expect(decodeURIComponent(f.calls[0]!.body)).toContain("field=id");
    const again = await adapter.getProfiles([2, 1]);
    expect(again.size).toBe(2);
    expect(f.calls).toHaveLength(1); // second lookup served from memory
  });

  it("detects the optional grade-report capability and reads quiz grades", async () => {
    const f = fakeFetch([
      {
        body: {
          functions: [
            { name: "core_enrol_get_enrolled_users" },
            { name: "gradereport_user_get_grade_items" },
          ],
        },
      },
      {
        body: {
          usergrades: [
            { userid: 5, gradeitems: [{ itemtype: "mod", itemmodule: "quiz", graderaw: 8, grademax: 10 }] },
          ],
        },
      },
    ]);
    const adapter = adapterWith(f.impl);
    expect(await adapter.capabilities()).toEqual({ grades: true });
    expect(await adapter.getCourseGrades(3)).toEqual([
      { userId: 5, items: [{ module: "quiz", type: "mod", raw: 8, max: 10 }] },
    ]);
  });
});

describe("Moodle text normalisation", () => {
  it("decodes format_string() entities and trims", async () => {
    const { text } = await import("@/connectors/moodle/adapter");
    expect(text(" Revitalife Maqui Berry &amp; Mangosteen ")).toBe("Revitalife Maqui Berry & Mangosteen");
    expect(text("O&#039;Neil &quot;GLB&quot; &#x26; co")).toBe(`O'Neil "GLB" & co`);
    expect(text("a\n  b")).toBe("a b");
    expect(text(null)).toBe("");
  });

  it("surfaces the Moodle errorcode and function, never Moodle's message", async () => {
    const f = fakeFetch([
      {
        body: { exception: "x", errorcode: "invalidparameter", message: `leak ${SECRET}`, debuginfo: SECRET },
      },
    ]);
    const err = await client(f.impl)
      .call("core_enrol_get_enrolled_users", {}, enrolledUsersSchema)
      .catch((e) => e);
    expect(err.message).toBe("The LMS returned an error (core_enrol_get_enrolled_users: invalidparameter).");
    expect(err.message).not.toContain(SECRET);
  });

  it("treats an undisclosed enablecompletion as unknown", async () => {
    const f = fakeFetch([
      { body: { courses: [{ id: 5, fullname: "A &amp; B", shortname: "AB", categoryid: 3, visible: 1 }] } },
    ]);
    const adapter = adapterWith(f.impl);
    const [course] = await adapter.listCourses();
    expect(course).toMatchObject({ fullName: "A & B", completionEnabled: null });
  });
});

describe("course-context errors", () => {
  it("surface Moodle's fixed reason with a hint, without links or tags", async () => {
    const message =
      'You cannot execute functions in the course context (course id:41). The context error message was: Site policy not agreed: <a href="https://lms.example/admin/tool/policy/index.php">Click here to open the site policy.</a>';
    const f = fakeFetch([{ body: { exception: "x", errorcode: "errorcoursecontextnotvalid", message } }]);
    const err = await client(f.impl)
      .call("core_enrol_get_enrolled_users", {}, enrolledUsersSchema)
      .catch((e) => e);
    expect(err.code).toBe("upstream_denied");
    expect(err.message).toMatch(/Site policy not agreed/);
    expect(err.message).toMatch(/Accept the site policy/);
    expect(err.message).not.toMatch(/<a|href|https:/);
  });
  it("hint for an incomplete service-account profile", async () => {
    const f = fakeFetch([
      {
        body: {
          exception: "x",
          errorcode: "errorcoursecontextnotvalid",
          message: "… The context error message was: User not fully set-up",
        },
      },
    ]);
    const err = await client(f.impl)
      .call("f", {}, enrolledUsersSchema)
      .catch((e) => e);
    expect(err.message).toMatch(/User not fully set-up.*required profile fields/);
  });
});
