import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  it("continues across calls and the final part matches a single-pass answer", async () => {
    const { buildMcpHandler } = await import("@/core/server");
    const { loadTenant } = await import("@/tenants/registry");
    const { FixtureLearningAdapter } = await import("@/connectors/fixture/adapter");
    const tenant = loadTenant("gla", "staging");
    const slow = new FixtureLearningAdapter({ nowSec: Math.floor(Date.now() / 1000) });
    const orig = slow.listCourseEnrolments.bind(slow);
    slow.listCourseEnrolments = async (id: number) => {
      await new Promise((r) => setTimeout(r, 1600));
      return orig(id);
    };
    const cfg = {
      tenant: { ...tenant, limits: { ...tenant.limits, requestBudgetMs: 5_000 } },
      env: "staging" as const,
      accessKeys: [KEY],
      dataSource: { kind: "none" as const },
    };
    const handler = buildMcpHandler(cfg, slow);
    const call = async (args: Record<string, unknown>) => {
      const body = await rpcBody(
        await handler(rpc("tools/call", { name: "query_metrics", arguments: args })),
      );
      return JSON.parse((body.result as { content: Array<{ text: string }> }).content[0]!.text);
    };
    const args = { group_by: ["region"], count_by: "enrolments", signals: ["site_last_access"] };
    const first = await call(args);
    expect(first.data.complete).toBe(false);
    expect(first.data.next_cursor).toBeTruthy();
    expect(first.data.rows).toEqual([]); // region rows need every course; none are shown early
    let page = first;
    let guard = 0;
    while (!page.data.complete && guard++ < 5) page = await call({ ...args, cursor: page.data.next_cursor });
    expect(page.data.complete).toBe(true);
    expect(page.data.progress.courses_done).toBe(page.data.progress.courses_total);

    // Same question answered by a fast source in one pass gives identical numbers.
    const fast = buildMcpHandler(
      { ...cfg, tenant },
      new FixtureLearningAdapter({ nowSec: Math.floor(Date.now() / 1000) }),
    );
    const body = await rpcBody(await fast(rpc("tools/call", { name: "query_metrics", arguments: args })));
    const single = JSON.parse((body.result as { content: Array<{ text: string }> }).content[0]!.text);
    expect(single.data.complete).toBe(true);
    expect(page.data.totals).toEqual(single.data.totals);
    expect(page.data.rows).toEqual(single.data.rows);
    expect(page.data.population).toEqual(single.data.population);

    // A tampered or mismatched cursor is rejected.
    const bad = await call({ ...args, group_by: ["level"], cursor: first.data.next_cursor });
    expect(bad.error.code).toBe("invalid_input");
  }, 30_000);
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
