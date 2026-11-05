import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FixtureLearningAdapter as Fixture } from "@/connectors/fixture/adapter";
import type { TenantConfig } from "@/tenants/schema";
import { KEY, rpcBody } from "./helpers";

const ENV = { MCP_TENANT: "gla", MCP_ENV: "staging", MCP_ACCESS_KEY: KEY, MCP_DATA_SOURCE: "fixture" };

async function loadRoute(env: Record<string, string | undefined> = ENV) {
  vi.resetModules();
  for (const k of [
    "MCP_TENANT",
    "MCP_ENV",
    "MCP_ACCESS_KEY",
    "MCP_DATA_SOURCE",
    "MOODLE_BASE_URL",
    "MOODLE_WS_TOKEN",
  ])
    delete process.env[k];
  Object.assign(process.env, env);
  return import("../app/api/mcp/route");
}

function rpc(method: string, params: unknown, key: string | null = KEY, id = 1): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
  };
  if (key !== null) headers["x-api-key"] = key;
  return new Request("http://localhost/api/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

async function callTool(
  POST: (r: Request) => Promise<Response>,
  name: string,
  args: Record<string, unknown>,
) {
  const body = await rpcBody(await POST(rpc("tools/call", { name, arguments: args })));
  const result = body.result as {
    isError?: boolean;
    content: Array<{ text: string }>;
    structuredContent?: Record<string, unknown>;
  };
  return { result, payload: JSON.parse(result.content[0]!.text) };
}

const silence = vi.spyOn(console, "log").mockImplementation(() => {});
const silenceErr = vi.spyOn(console, "error").mockImplementation(() => {});
afterAll(() => {
  silence.mockRestore();
  silenceErr.mockRestore();
});

describe("POST /api/mcp", () => {
  let POST: (r: Request) => Promise<Response>;
  beforeEach(async () => {
    ({ POST } = await loadRoute());
  });

  it("rejects requests without or with a wrong x-api-key before MCP runs", async () => {
    for (const key of [null, "wrong", `Bearer ${KEY}`]) {
      const res = await POST(rpc("tools/list", {}, key));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBeNull();
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("lists the six general-purpose read-only tools", async () => {
    const init = await rpcBody(
      await POST(
        rpc("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        }),
      ),
    );
    expect(JSON.stringify(init)).toContain("web-only");
    const list = await rpcBody(await POST(rpc("tools/list", {})));
    const tools = (
      list.result as { tools: Array<{ name: string; title: string; annotations: Record<string, boolean> }> }
    ).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "describe_capabilities",
      "get_person",
      "list_courses",
      "list_dimension_values",
      "list_people",
      "query_metrics",
    ]);
    expect(
      tools.every((t) => t.annotations.readOnlyHint === true && t.annotations.destructiveHint === false),
    ).toBe(true);
    expect(tools.find((t) => t.name === "get_person")!.title).toBe("Dealer detail");
  });

  it("describe_capabilities states each signal's definition and availability", async () => {
    const { payload } = await callTool(POST, "describe_capabilities", {});
    const web = payload.signals.find((s: { id: string }) => s.id === "web_course_access");
    expect(web.sees_app_activity).toBe(false);
    expect(payload.signals.find((s: { id: string }) => s.id === "avg_score").available).toBe(true);
    expect(Object.keys(payload.population)).toEqual(["dealer", "legacy", "excluded", "default"]);
  });

  it("list_courses hides invisible courses and flags unnamed categories", async () => {
    const { payload } = await callTool(POST, "list_courses", {});
    expect(payload.data.courses.map((c: { id: number }) => c.id)).not.toContain(31);
    expect(payload.warnings.join(" ")).toMatch(/id\(s\) 9 .*do not guess/);
    expect(payload.diagnostics.ms).toBeGreaterThanOrEqual(0);
  });

  it("query_metrics: dealers only by default, with population counts and look-alike notes", async () => {
    const { result, payload } = await callTool(POST, "query_metrics", {
      course_ids: [10, 11],
      group_by: ["region"],
      recent_days: 30,
    });
    expect(result.isError).toBeFalsy();
    expect(payload.data.complete).toBe(true);
    expect(payload.data.population).toMatchObject({ legacy: 3, excluded: 6 });
    expect(payload.data.totals.enrolled).toBe(payload.data.population.dealer);
    expect(payload.data.totals.started.unknown).toBe(0);
    const sum = payload.data.rows.reduce((n: number, r: { enrolled: number }) => n + r.enrolled, 0);
    expect(sum).toBe(payload.data.totals.enrolled);
    expect(payload.warnings.join(" ")).toMatch(/"Visayas", "Visayas 1", "Visayas 2" are separate values/);
  });

  it("query_metrics: population can be combined on request", async () => {
    const only = await callTool(POST, "query_metrics", { course_ids: [10], signals: ["site_last_access"] });
    const both = await callTool(POST, "query_metrics", {
      course_ids: [10],
      signals: ["site_last_access"],
      population: ["dealer", "legacy"],
    });
    expect(both.payload.data.totals.enrolled).toBe(only.payload.data.totals.enrolled + 3);
  });

  it("query_metrics: per-course enrolment metrics with average score", async () => {
    const { payload } = await callTool(POST, "query_metrics", {
      group_by: ["course"],
      signals: ["site_last_access", "avg_score"],
    });
    expect(payload.data.unit).toBe("enrolments");
    expect(payload.data.complete).toBe(true);
    expect(payload.data.next_cursor).toBeNull();
    expect(payload.data.rows[0].group.course.name).toBeTruthy();
    expect(payload.data.rows[0].avg_score.avg_score_pct).toBeGreaterThan(0);
  });

  it("query_metrics: web course access always carries its web-only caveat", async () => {
    const { payload } = await callTool(POST, "query_metrics", {
      course_ids: [10],
      signals: ["web_course_access"],
    });
    expect(payload.warnings.join(" ")).toMatch(/Web only/);
  });

  it("list_people: who has not started, and legacy accounts for review", async () => {
    const notStarted = await callTool(POST, "list_people", {
      course_id: 10,
      where: { signal: "started", state: "no" },
      limit: 100,
    });
    expect(notStarted.payload.data.people.every((p: { started: boolean }) => p.started === false)).toBe(true);
    const legacy = await callTool(POST, "list_people", { course_id: 10, population: ["legacy"] });
    expect(legacy.payload.data.people.map((p: { identifier: string }) => p.identifier).sort()).toEqual([
      "fb 007700901",
      "legacy.user",
      "nl_0999_0007",
    ]);
    expect(legacy.payload.data.people.every((p: { status: string }) => p.status === "legacy")).toBe(true);
  });

  it("get_person: repairs a dropped leading zero", async () => {
    const { payload } = await callTool(POST, "get_person", { identifier: "03210000000" });
    expect(payload.data.person.identifier).toBe("003210000000");
    expect(payload.data.person.status).toBe("dealer");
    expect(payload.data.courses.length).toBeGreaterThan(0);
  });

  it("returns safe errors for invalid scope", async () => {
    const { result, payload } = await callTool(POST, "list_people", { course_id: 31 });
    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe("not_found");
  });

  it("accepts a category id whose name is hidden from the service account", async () => {
    const { result, payload } = await callTool(POST, "query_metrics", {
      category_ids: [9],
      signals: ["site_last_access"],
    });
    expect(result.isError).toBeFalsy();
    expect(payload.scope.courses.map((c: { id: number }) => c.id)).toEqual([40]);
  });
});

describe("answers in parts (stateless cursor)", () => {
  type Limits = Partial<TenantConfig["limits"]>;
  async function handlers(limits: Limits, slow: (a: Fixture) => void) {
    const { buildMcpHandler } = await import("@/core/server");
    const { loadTenant } = await import("@/tenants/registry");
    const { FixtureLearningAdapter } = await import("@/connectors/fixture/adapter");
    const tenant = loadTenant("gla", "staging");
    const now = Math.floor(Date.now() / 1000);
    const cfg = (l: Limits) => ({
      tenant: { ...tenant, limits: { ...tenant.limits, ...l } },
      env: "staging" as const,
      accessKeys: [KEY],
      dataSource: { kind: "none" as const },
    });
    const slowPort = new FixtureLearningAdapter({ nowSec: now });
    slow(slowPort);
    const caller = (h: (r: Request) => Promise<Response>) => async (args: Record<string, unknown>) => {
      const body = await rpcBody(await h(rpc("tools/call", { name: "query_metrics", arguments: args })));
      return JSON.parse((body.result as { content: Array<{ text: string }> }).content[0]!.text);
    };
    return {
      slowPort,
      slowCall: caller(buildMcpHandler(cfg(limits), slowPort)),
      fastCall: caller(
        buildMcpHandler(
          cfg({ ...limits, requestBudgetMs: 50_000, maxPeopleForPersonSignals: 10_000 }),
          new FixtureLearningAdapter({ nowSec: now }),
        ),
      ),
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON tool payloads
  type Part = { data: any; warnings: string[]; error?: { code: string } };
  const last = (p: Part[]): Part => p[p.length - 1]!;
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function untilComplete(
    call: (a: Record<string, unknown>) => Promise<Part>,
    args: Record<string, unknown>,
  ) {
    const parts = [await call(args)];
    while (!last(parts).data.complete && parts.length < 12) {
      parts.push(await call({ ...args, cursor: last(parts).data.next_cursor }));
    }
    return parts;
  }

  it("splits large courses by page; per-course rows and totals equal a single pass", async () => {
    const { slowCall, fastCall } = await handlers(
      { requestBudgetMs: 5_000, participantsPageSize: 50 },
      (p) => {
        const orig = p.listCourseEnrolmentsPage.bind(p);
        p.listCourseEnrolmentsPage = async (...a) => (await delay(450), orig(...a));
      },
    );
    const args = { group_by: ["course"], signals: ["site_last_access"], recent_days: 30 };
    const parts = await untilComplete(slowCall, args);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.slice(0, -1).some((p) => p.data.progress.course_in_progress)).toBe(true); // split mid-course
    const single = await fastCall(args);
    const rows = parts.flatMap((p) => p.data.rows).sort((a, b) => a.group.course.id - b.group.course.id);
    expect(rows).toEqual([...single.data.rows].sort((a, b) => a.group.course.id - b.group.course.id));
    expect(last(parts).data.totals).toEqual(single.data.totals);
    expect(last(parts).data.population).toEqual(single.data.population);
    const bad = await slowCall({ ...args, group_by: ["level"], cursor: parts[0]!.data.next_cursor });
    expect(bad.error!.code).toBe("invalid_input");
  }, 60_000);

  it("non-course groupings arrive complete with the last part", async () => {
    const { slowCall, fastCall } = await handlers(
      { requestBudgetMs: 5_000, participantsPageSize: 50 },
      (p) => {
        const orig = p.listCourseEnrolmentsPage.bind(p);
        p.listCourseEnrolmentsPage = async (...a) => (await delay(450), orig(...a));
      },
    );
    const args = { group_by: ["region"], count_by: "enrolments", signals: ["site_last_access"] };
    const parts = await untilComplete(slowCall, args);
    expect(parts.length).toBeGreaterThan(1);
    // look-alike notes cover regions seen in every part, not only the last one
    expect(last(parts).warnings.join(" ")).toMatch(/"Visayas", "Visayas 1", "Visayas 2" are separate values/);
    expect(parts.slice(0, -1).every((p) => p.data.rows.length === 0)).toBe(true);
    const single = await fastCall(args);
    expect(last(parts).data.rows).toEqual(single.data.rows);
    expect(last(parts).data.totals).toEqual(single.data.totals);
  }, 60_000);

  it("answers 'started' for more people than fit one call, in people batches", async () => {
    const { slowCall, fastCall } = await handlers(
      { requestBudgetMs: 5_000 }, // default 300-person threshold: batching must still kick in
      (p) => {
        const orig = p.listPersonCourses.bind(p);
        p.listPersonCourses = async (id) => (await delay(120), orig(id));
      },
    );
    const args = { course_ids: [10], group_by: ["region"], signals: ["started", "completion"] };
    const parts = await untilComplete(slowCall, args);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]!.data.progress.people_total).toBeLessThan(300);
    expect(last(parts).data.skipped_signals).toBeUndefined();
    const single = await fastCall(args);
    expect(single.data.complete).toBe(true);
    expect(last(parts).data.totals).toEqual(single.data.totals);
    expect(last(parts).data.rows).toEqual(single.data.rows);
    expect(last(parts).data.population).toEqual(single.data.population);
    expect(last(parts).data.totals.started.unknown).toBe(0);
  }, 60_000);

  it("resumes people batches by key, so removing an already-counted person skips nobody", async () => {
    const { slowPort, slowCall, fastCall } = await handlers({ requestBudgetMs: 5_000 }, (p) => {
      const orig = p.listPersonCourses.bind(p);
      p.listPersonCourses = async (id) => (await delay(120), orig(id));
    });
    const args = { course_ids: [10], signals: ["started"] };
    const single = await fastCall(args);
    const first = await slowCall(args);
    expect(first.data.complete).toBe(false);
    // Remove the dealer with the smallest counting key (processed in part 1) from the course.
    const { classify } = await import("@/domain/people");
    const { loadTenant } = await import("@/tenants/registry");
    const tenant = loadTenant("gla", "staging");
    const enrolled = slowPort.people.filter((x) => slowPort.access.get(10)?.has(x.userId));
    const dealers = enrolled
      .map((x) => ({ x, v: classify({ ...x, courseRoles: [x.role] }, tenant) }))
      .filter((d) => d.v.status === "person")
      .sort((a, b) => (a.v.key < b.v.key ? -1 : 1));
    slowPort.access.get(10)!.delete(dealers[0]!.x.userId);
    const parts = [first];
    while (!last(parts).data.complete && parts.length < 12) {
      parts.push(await slowCall({ ...args, cursor: last(parts).data.next_cursor }));
    }
    // Index-based resumption would skip one unprocessed dealer here.
    expect(last(parts).data.totals.enrolled).toBe(single.data.totals.enrolled);
  }, 60_000);

  it("avg_score works in parts, and is skipped (explicitly) alongside per-person signals", async () => {
    const { slowCall, fastCall } = await handlers(
      { requestBudgetMs: 5_000, participantsPageSize: 50 },
      (p) => {
        const orig = p.listCourseEnrolmentsPage.bind(p);
        p.listCourseEnrolmentsPage = async (...a) => (await delay(450), orig(...a));
      },
    );
    const args = { group_by: ["course"], signals: ["avg_score"] };
    const parts = await untilComplete(slowCall, args);
    const single = await fastCall(args);
    expect(parts.length).toBeGreaterThan(1);
    expect(last(parts).data.totals).toEqual(single.data.totals);
    expect(single.data.totals.avg_score.graded_items).toBeGreaterThan(0);
    const mixed = await fastCall({ course_ids: [10], signals: ["started", "avg_score"] });
    expect(mixed.data.skipped_signals.map((x: { signal: string }) => x.signal)).toEqual(["avg_score"]);
  }, 60_000);
});

describe("list_people paging and population details", () => {
  async function handlerWith(limits: Partial<TenantConfig["limits"]>, tweak?: (p: Fixture) => void) {
    const { buildMcpHandler } = await import("@/core/server");
    const { loadTenant } = await import("@/tenants/registry");
    const { FixtureLearningAdapter } = await import("@/connectors/fixture/adapter");
    const tenant = loadTenant("gla", "staging");
    const port = new FixtureLearningAdapter({ nowSec: Math.floor(Date.now() / 1000) });
    tweak?.(port);
    const h = buildMcpHandler(
      {
        tenant: { ...tenant, limits: { ...tenant.limits, ...limits } },
        env: "staging",
        accessKeys: [KEY],
        dataSource: { kind: "none" },
      },
      port,
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const body = await rpcBody(await h(rpc("tools/call", { name, arguments: args })));
      return JSON.parse((body.result as { content: Array<{ text: string }> }).content[0]!.text);
    };
    return { port, call };
  }

  it("enrolment_order browses page by page and returns the same people as the sorted list", async () => {
    const { call } = await handlerWith({ participantsPageSize: 50 });
    const sortedNames: string[] = [];
    for (let offset: number | null = 0; offset !== null;) {
      const pg = await call("list_people", {
        course_id: 10,
        limit: 100,
        offset,
        population: ["dealer", "legacy"],
      });
      sortedNames.push(...pg.data.people.map((p: { name: string }) => p.name));
      offset = pg.data.next_offset;
    }
    const ids: string[] = [];
    let cursor: string | undefined;
    let calls = 0;
    do {
      const page = await call("list_people", {
        course_id: 10,
        sort: "enrolment_order",
        limit: 30,
        population: ["dealer", "legacy"],
        ...(cursor ? { cursor } : {}),
      });
      expect(page.data.people.length).toBeLessThanOrEqual(30);
      ids.push(...page.data.people.map((p: { name: string }) => p.name));
      cursor = page.data.next_cursor ?? undefined;
    } while (cursor && ++calls < 20);
    expect(new Set(ids).size).toBe(ids.length); // no repeats across pages
    expect(ids.sort()).toEqual(sortedNames.sort());
  });

  it("rejects mismatched paging, points to enrolment_order only when out of time, passes outages through", async () => {
    const { call } = await handlerWith({});
    expect(
      (await call("list_people", { course_id: 10, sort: "enrolment_order", search: "deal" })).error.code,
    ).toBe("invalid_input");
    expect(
      (await call("list_people", { course_id: 10, sort: "enrolment_order", offset: 50 })).error.code,
    ).toBe("invalid_input");
    expect((await call("list_people", { course_id: 10, cursor: "0:5" })).error.code).toBe("invalid_input");
    const { AppError } = await import("@/core/errors");
    const fail = (code: "scope_too_large" | "upstream_unavailable") => (p: Fixture) => {
      p.getProfiles = async () => {
        throw new AppError(code, "x");
      };
    };
    const tooBig = await (
      await handlerWith({}, fail("scope_too_large"))
    ).call("list_people", { course_id: 10 });
    expect(tooBig.error.code).toBe("scope_too_large");
    expect(tooBig.error.message).toMatch(/enrolment_order/);
    const outage = await (
      await handlerWith({}, fail("upstream_unavailable"))
    ).call("list_people", { course_id: 10 });
    expect(outage.error.code).toBe("upstream_unavailable");
    expect(outage.error.message).not.toMatch(/too large/);
  });

  it("enrolment_order keeps going when matches are rare, returning a cursor even with no matches yet", async () => {
    const { call } = await handlerWith({ participantsPageSize: 50, requestBudgetMs: 5_000 }, (p) => {
      const orig = p.listCourseEnrolmentsPage.bind(p);
      p.listCourseEnrolmentsPage = async (...a) => (
        await new Promise((r) => setTimeout(r, 2_600)),
        orig(...a)
      );
    });
    // excluded accounts are rare in the fixture and sit at the end of the enrolment order
    const first = await call("list_people", {
      course_id: 10,
      sort: "enrolment_order",
      population: ["excluded"],
    });
    expect(first.error).toBeUndefined();
    expect(first.data.next_cursor).toMatch(/^\d+:\d+$/);
    const found: string[] = [...first.data.people.map((p: { status: string }) => p.status)];
    let cursor = first.data.next_cursor;
    for (let i = 0; cursor && i < 6; i++) {
      const page = await call("list_people", {
        course_id: 10,
        sort: "enrolment_order",
        population: ["excluded"],
        cursor,
      });
      found.push(...page.data.people.map((p: { status: string }) => p.status));
      cursor = page.data.next_cursor;
    }
    expect(cursor).toBeNull();
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((x) => x === "excluded")).toBe(true);
  }, 60_000);

  it("reports merged duplicate accounts when a Dealer has two accounts in scope", async () => {
    const { port, call } = await handlerWith({});
    const { EDGE } = await import("@/connectors/fixture/adapter");
    // make sure both the original account and its duplicate are enrolled in course 10
    port.access.get(10)!.set(1000, null);
    port.access.get(10)!.set(EDGE.dupDropped0, null);
    const res = await call("query_metrics", { course_ids: [10], signals: ["site_last_access"] });
    expect(res.data.population.dealer_duplicate_accounts_merged).toBe(1);
    const list = await call("list_people", { course_id: 10, limit: 1 });
    expect(list.data.population.dealer_duplicate_accounts_merged).toBe(1);
    expect(list.data.matched_accounts - list.data.matched_people).toBe(1);
  });
});

describe("misconfiguration", () => {
  it("fails closed with 500 when the access key is missing", async () => {
    const { POST } = await loadRoute({ MCP_TENANT: "gla", MCP_ENV: "staging" });
    const res = await POST(rpc("tools/list", {}));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server_misconfigured" });
  });

  it("tools report not_configured when no LMS credentials are set", async () => {
    const { POST } = await loadRoute({ MCP_TENANT: "gla", MCP_ENV: "staging", MCP_ACCESS_KEY: KEY });
    const { result, payload } = await callTool(POST, "list_courses", {});
    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe("not_configured");
  });
});
