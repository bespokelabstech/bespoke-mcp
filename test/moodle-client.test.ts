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

describe("MoodleLearningAdapter", () => {
  it("pages enrolled users, keeps only needed fields and maps custom fields", async () => {
    const user = (id: number) => ({
      id,
      username: `u${id}`,
      firstname: "F",
      lastname: "L",
      email: "x@example.com",
      roles: [{ roleid: 5, shortname: "student" }],
      customfields: [
        { shortname: "level", value: "Great Life Builder" },
        { shortname: "branch_code", value: " CUBAO (0101) " },
      ],
      lastcourseaccess: id === 2 ? 0 : 1_700_000_000,
    });
    const f = fakeFetch([{ body: [user(1), user(2)] }, { body: [user(3)] }]);
    const adapter = new MoodleLearningAdapter({
      settings: { baseUrl: "https://lms.example", token: SECRET, timeoutMs: 2000 },
      pageSize: 2,
      cacheTtlSeconds: 60,
      fetchImpl: f.impl,
    });
    const people = await adapter.listCourseParticipants(7);
    expect(people.map((p) => p.userId)).toEqual([1, 2, 3]);
    expect(people[0]).toEqual({
      userId: 1,
      username: "u1",
      firstName: "F",
      lastName: "L",
      courseRoles: ["student"],
      profile: { level: "Great Life Builder", branch_code: "CUBAO (0101)" },
      lastCourseAccess: 1_700_000_000,
    });
    expect(people[1]!.lastCourseAccess).toBeNull();
    expect(f.calls[1]!.body).toContain("options%5B2%5D%5Bvalue%5D=2"); // limitfrom=2 on page 2
    expect(decodeURIComponent(f.calls[0]!.body)).toContain("onlyactive");
    // cached on the second call
    await adapter.listCourseParticipants(7);
    expect(f.calls).toHaveLength(2);
  });
});
