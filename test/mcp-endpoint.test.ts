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

  it("describe_capabilities carries the glossary, saved filter, defaults and signals", async () => {
    const { payload } = await callTool(POST, "describe_capabilities", {});
    const web = payload.signals.find((s: { id: string }) => s.id === "web_course_access");
    expect(web.sees_app_activity).toBe(false);
    expect(payload.signals.find((s: { id: string }) => s.id === "avg_score").available).toBe(true);
    const term = (label: string) => payload.glossary.terms.find((g: { label: string }) => g.label === label);
    expect(term("Logged in").meaning).toBe(
      "Signed in to the app at least once. Within a date range: had a session in the range.",
    );
    expect(term("Logged in").in_this_connector).toMatch(/last sign-in/);
    expect(term("Valid dealer").meaning).toBe(
      "Not hidden by the `valid_dealers` saved filter (rules below). This includes being one of the 4 dealer levels.",
    );
    const sf = payload.saved_filters.valid_dealers;
    expect(sf.provisional).toBe(true);
    expect(new Set(sf.hide.map((c: { field: string }) => c.field))).toEqual(
      new Set(["email", "username", "name", "status", "level"]),
    );
    expect(payload.defaults).toMatchObject({ valid_only: true, saved_filter: "valid_dealers" });
  });

  it("list_courses hides invisible courses and flags unnamed categories", async () => {
    const { payload } = await callTool(POST, "list_courses", {});
    expect(payload.data.courses.map((c: { id: number }) => c.id)).not.toContain(31);
    expect(payload.warnings.join(" ")).toMatch(/id\(s\) 9 .*do not guess/);
    expect(payload.diagnostics.ms).toBeGreaterThanOrEqual(0);
  });

  it("query_metrics: valid dealers by default, with population counts by rule", async () => {
    const { result, payload } = await callTool(POST, "query_metrics", {
      course_ids: [10, 11],
      group_by: ["region"],
      recent_days: 30,
    });
    expect(result.isError).toBeFalsy();
    expect(payload.data.complete).toBe(true);
    const pop = payload.data.population;
    expect(pop.counted).toBe("valid_dealers");
    expect(pop.not_valid).toMatchObject({
      "Internal email domain": 1,
      "Suspended account": 1,
      "Dummy Conso ID": 1,
    });
    const hidden = Object.values(pop.not_valid as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(pop.learner_accounts - pop.valid_dealers).toBe(hidden);
    expect(payload.filters).toEqual({ saved_filter: "valid_dealers" }); // no other defaults
    expect(payload.data.totals.enrolled).toBe(pop.valid_dealers);
    expect(payload.data.totals.accessed.unknown).toBe(0);
    // Accessed is all-time: with a date range the access rate is not computed, and a warning says so
    expect(payload.data.totals.accessed.access_rate_pct).toBeNull();
    const w = payload.warnings.join(" ");
    expect(w).toMatch(/All-time only/);
    expect(w).toMatch(/stored on each profile/);
    expect(w).not.toMatch(/not visible|Unexpected/);
    // every fixture account shows its email domain and status
    const sum = payload.data.rows.reduce((n: number, r: { enrolled: number }) => n + r.enrolled, 0);
    expect(sum).toBe(payload.data.totals.enrolled);
    expect(w).toMatch(/"Visayas", "Visayas 1", "Visayas 2" are separate values/);
  });

  it("query_metrics: all accounts on request (valid_only=false), COE included", async () => {
    const args = { course_ids: [10], signals: ["logged_in"] };
    const only = await callTool(POST, "query_metrics", args);
    const all = await callTool(POST, "query_metrics", { ...args, valid_only: false });
    const pop = only.payload.data.population;
    expect(all.payload.data.totals.enrolled).toBe(pop.learner_accounts);
    expect(all.payload.data.totals.enrolled - only.payload.data.totals.enrolled).toBe(
      pop.learner_accounts - pop.valid_dealers,
    );
    expect(all.payload.data.population.counted).toBe("all");
    const coe = await callTool(POST, "query_metrics", {
      ...args,
      valid_only: false,
      filters: { level: ["PC Center of Excellence"] },
    });
    expect(coe.payload.data.totals.enrolled).toBe(1);
  });

  it("warns when the LMS hides email addresses, and flags unexpected Dealer Levels", async () => {
    const { buildMcpHandler } = await import("@/core/server");
    const { loadTenant } = await import("@/tenants/registry");
    const { FixtureLearningAdapter, EDGE } = await import("@/connectors/fixture/adapter");
    const port = new FixtureLearningAdapter({ nowSec: Math.floor(Date.now() / 1000) });
    for (const p of port.people) p.emailDomain = null;
    port.people.find((p) => p.userId === EDGE.dealerAlnum)!.profile.level = "Head Office";
    const h = buildMcpHandler(
      {
        tenant: loadTenant("gla", "staging"),
        env: "staging",
        accessKeys: [KEY],
        dataSource: { kind: "none" },
      },
      port,
    );
    const body = await rpcBody(
      await h(
        rpc("tools/call", {
          name: "query_metrics",
          arguments: { course_ids: [10], signals: ["logged_in"] },
        }),
      ),
    );
    const out = JSON.parse((body.result as { content: Array<{ text: string }> }).content[0]!.text);
    const w = out.warnings.join(" ");
    expect(w).toMatch(
      /Email addresses were not visible for any accounts checked, so rule "Internal email domain"/,
    );
    expect(w).toMatch(/Unexpected Dealer Level value\(s\) "Head Office"/);
  });

  it("query_metrics: sorts on any column and checks the column's metric was asked for", async () => {
    const { payload } = await callTool(POST, "query_metrics", {
      group_by: ["region"],
      count_by: "enrolments",
      signals: ["logged_in"],
      sort: "group",
    });
    const labels = payload.data.rows.map((r: { group: { region: string } }) => r.group.region);
    expect(labels).toEqual([...labels].sort((a: string, b: string) => a.localeCompare(b)));
    const bad = await callTool(POST, "query_metrics", {
      course_ids: [10],
      signals: ["logged_in"],
      sort: "-accessed",
    });
    expect(bad.payload.error.code).toBe("invalid_input");
  });

  it("query_metrics: groups by category and rejects unknown (old) argument names", async () => {
    const { payload } = await callTool(POST, "query_metrics", {
      group_by: ["category"],
      count_by: "enrolments",
      signals: ["logged_in"],
    });
    expect(
      payload.data.rows.map((r: { group: { category: { id: number } } }) => r.group.category.id).sort(),
    ).toEqual([2, 3, 4, 9]);
    const old = await rpcBody(
      await POST(
        rpc("tools/call", { name: "query_metrics", arguments: { course_ids: [10], since: "2026-01-01" } }),
      ),
    );
    const oldResult = old.result as { isError: boolean; content: Array<{ text: string }> };
    expect(oldResult.isError).toBe(true);
    expect(oldResult.content[0]!.text).toMatch(/since/);
  });

  it("query_metrics: per-course enrolment metrics with average score", async () => {
    const { payload } = await callTool(POST, "query_metrics", {
      group_by: ["course"],
      signals: ["logged_in", "avg_score"],
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

  it("reports partly visible emails, and carries data warnings to the last part", async () => {
    const { buildMcpHandler } = await import("@/core/server");
    const { loadTenant } = await import("@/tenants/registry");
    const { FixtureLearningAdapter, EDGE } = await import("@/connectors/fixture/adapter");
    const tenant = loadTenant("gla", "staging");
    const port = new FixtureLearningAdapter({ nowSec: Math.floor(Date.now() / 1000) });
    port.people.find((p) => p.userId === EDGE.legacyFb)!.emailDomain = null; // hidden by the account's setting
    port.people.find((p) => p.userId === EDGE.dealerAlnum)!.profile.level = "Head Office"; // an edge: last in order
    const slow = port.listCourseEnrolmentsPage.bind(port);
    port.listCourseEnrolmentsPage = async (...a) => (
      await new Promise((r) => setTimeout(r, 450)),
      slow(...a)
    );
    const h = buildMcpHandler(
      {
        tenant: { ...tenant, limits: { ...tenant.limits, requestBudgetMs: 5_000, participantsPageSize: 50 } },
        env: "staging",
        accessKeys: [KEY],
        dataSource: { kind: "none" },
      },
      port,
    );
    const call = async (args: Record<string, unknown>) => {
      const body = await rpcBody(await h(rpc("tools/call", { name: "query_metrics", arguments: args })));
      return JSON.parse((body.result as { content: Array<{ text: string }> }).content[0]!.text);
    };
    const args = { group_by: ["course"], signals: ["logged_in"] };
    const parts = [await call(args)];
    while (!parts.at(-1).data.complete && parts.length < 15) {
      parts.push(await call({ ...args, cursor: parts.at(-1).data.next_cursor }));
    }
    expect(parts.length).toBeGreaterThan(1);
    const w = parts.at(-1).warnings.join(" ");
    expect(w).toMatch(/Email addresses were not visible for \d+ of \d+ accounts checked/);
    expect(w).toMatch(/Unexpected Dealer Level value\(s\) "Head Office"/);
  }, 60_000);

  it("list_people: who has not accessed, accounts hidden by the saved filter, sorting", async () => {
    const notAccessed = await callTool(POST, "list_people", {
      course_id: 10,
      where: { signal: "accessed", state: "no" },
      limit: 100,
    });
    expect(notAccessed.payload.data.people.every((p: { accessed: boolean }) => p.accessed === false)).toBe(
      true,
    );
    const rows: Array<{ valid: boolean; not_valid_because?: string[] }> = [];
    let all;
    for (let offset: number | null = 0; offset !== null; offset = all.payload.data.next_offset) {
      all = await callTool(POST, "list_people", { course_id: 10, valid_only: false, limit: 100, offset });
      rows.push(...all.payload.data.people);
    }
    const failing = rows.filter((p) => !p.valid);
    const pop = all!.payload.data.population;
    expect(failing.length).toBe(pop.learner_accounts - pop.valid_dealers);
    expect(failing.every((p) => (p.not_valid_because ?? []).length > 0)).toBe(true);
    expect(JSON.stringify(all!.payload)).not.toMatch(/@example\.com|@bihasa/); // email domains are never returned
    const bySignIn = await callTool(POST, "list_people", {
      course_id: 10,
      sort: "-last_sign_in",
      limit: 100,
    });
    const times = bySignIn.payload.data.people
      .map((p: { last_sign_in: string | null }) => p.last_sign_in)
      .filter((x: string | null) => x !== null);
    expect(times).toEqual([...times].sort().reverse());
    expect(bySignIn.payload.data.people.at(-1).last_sign_in).toBeNull(); // nulls last
  });

  it("get_person: looks up the username as stored (no repair) and says which rules hide it", async () => {
    const { payload } = await callTool(POST, "get_person", { identifier: "003210000000" });
    expect(payload.data.person.conso_id).toBe("003210000000");
    expect(payload.data.person.conso_id_from_username).toBeUndefined();
    expect(payload.data.person.valid).toBe(false); // the fixture's first dealer has a blank level
    expect(payload.data.person.not_valid_because).toEqual(["COE or blank Dealer Level"]);
    expect(payload.data.courses.length).toBeGreaterThan(0);
    const ok = await callTool(POST, "get_person", { identifier: "500000J99901" });
    expect(ok.payload.data.person.valid).toBe(true);
    const dropped = await callTool(POST, "get_person", { identifier: "03210000000" });
    expect(dropped.payload.error.code).toBe("not_found");
  });

  it("returns safe errors for invalid scope", async () => {
    const { result, payload } = await callTool(POST, "list_people", { course_id: 31 });
    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe("not_found");
  });

  it("accepts a category id whose name is hidden from the service account", async () => {
    const { result, payload } = await callTool(POST, "query_metrics", {
      category_ids: [9],
      signals: ["logged_in"],
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
    const args = { group_by: ["course"], signals: ["logged_in"], recent_days: 30 };
    const parts = await untilComplete(slowCall, args);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.slice(0, -1).some((p) => p.data.progress.course_in_progress)).toBe(true); // split mid-course
    expect(parts.slice(0, -1).every((p) => p.data.rows.length === 0)).toBe(true); // all rows come last, sortable
    const single = await fastCall(args);
    expect(last(parts).data.rows).toEqual(single.data.rows);
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
    const args = { group_by: ["region"], count_by: "enrolments", signals: ["logged_in"] };
    const parts = await untilComplete(slowCall, args);
    expect(parts.length).toBeGreaterThan(1);
    // look-alike notes cover regions seen in every part, not only the last one
    expect(last(parts).warnings.join(" ")).toMatch(/"Visayas", "Visayas 1", "Visayas 2" are separate values/);
    expect(parts.slice(0, -1).every((p) => p.data.rows.length === 0)).toBe(true);
    const single = await fastCall(args);
    expect(last(parts).data.rows).toEqual(single.data.rows);
    expect(last(parts).data.totals).toEqual(single.data.totals);
  }, 60_000);

  it("answers 'accessed' for more accounts than fit one call, in account batches", async () => {
    const { slowCall, fastCall } = await handlers(
      { requestBudgetMs: 5_000 }, // default 300-person threshold: batching must still kick in
      (p) => {
        const orig = p.listPersonCourses.bind(p);
        p.listPersonCourses = async (id) => (await delay(120), orig(id));
      },
    );
    const args = { course_ids: [10], group_by: ["region"], signals: ["accessed", "progress"] };
    const parts = await untilComplete(slowCall, args);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]!.data.progress.accounts_total).toBeLessThan(300);
    expect(last(parts).data.skipped_signals).toBeUndefined();
    const single = await fastCall(args);
    expect(single.data.complete).toBe(true);
    expect(last(parts).data.totals).toEqual(single.data.totals);
    expect(last(parts).data.rows).toEqual(single.data.rows);
    expect(last(parts).data.population).toEqual(single.data.population);
    expect(last(parts).data.totals.accessed.unknown).toBe(0);
  }, 60_000);

  it("resumes account batches by key, so removing an already-counted account skips nobody", async () => {
    const { slowPort, slowCall, fastCall } = await handlers({ requestBudgetMs: 5_000 }, (p) => {
      const orig = p.listPersonCourses.bind(p);
      p.listPersonCourses = async (id) => (await delay(120), orig(id));
    });
    const args = { course_ids: [10], signals: ["accessed"] };
    const single = await fastCall(args);
    const first = await slowCall(args);
    expect(first.data.complete).toBe(false);
    // Remove the account with the smallest key (processed in part 1) from the course.
    const enrolled = slowPort.people
      .filter((x) => slowPort.access.get(10)?.has(x.userId))
      .sort((a, b) => a.userId - b.userId);
    slowPort.access.get(10)!.delete(enrolled[0]!.userId);
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
    const mixed = await fastCall({ course_ids: [10], signals: ["accessed", "avg_score"] });
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
      const pg = await call("list_people", { course_id: 10, limit: 100, offset });
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
    // the one COE account is rare in the fixture and sits at the end of the enrolment order
    const coe = { level: ["PC Center of Excellence"] };
    const first = await call("list_people", {
      course_id: 10,
      sort: "enrolment_order",
      filters: coe,
      valid_only: false,
    });
    expect(first.error).toBeUndefined();
    expect(first.data.next_cursor).toMatch(/^\d+:\d+$/);
    const found: string[] = [...first.data.people.map((p: { level: string }) => p.level)];
    let cursor = first.data.next_cursor;
    for (let i = 0; cursor && i < 6; i++) {
      const page = await call("list_people", {
        course_id: 10,
        sort: "enrolment_order",
        filters: coe,
        valid_only: false,
        cursor,
      });
      found.push(...page.data.people.map((p: { level: string }) => p.level));
      cursor = page.data.next_cursor;
    }
    expect(cursor).toBeNull();
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((x) => x === "PC Center of Excellence")).toBe(true);
  }, 60_000);

  it("counts two accounts of the same Dealer separately (no merging, no ID repair)", async () => {
    const { port, call } = await handlerWith({});
    const { EDGE } = await import("@/connectors/fixture/adapter");
    port.access.get(10)!.set(1000, null);
    port.access.get(10)!.set(EDGE.dupDropped0, null);
    const list = await call("list_people", { course_id: 10, search: "3210000000", valid_only: false });
    expect(list.data.matched).toBe(2);
    expect(list.data.people.map((p: { conso_id: string }) => p.conso_id).sort()).toEqual([
      "003210000000",
      "03210000000",
    ]);
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
