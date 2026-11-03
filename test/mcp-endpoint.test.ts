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

  it("initializes with tenant instructions and lists the five read-only tools", async () => {
    const init = await rpcBody(
      await POST(
        rpc("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        }),
      ),
    );
    expect(JSON.stringify(init)).toContain("Dealer");
    const list = await rpcBody(await POST(rpc("tools/list", {})));
    const tools = (list.result as { tools: Array<{ name: string; annotations: Record<string, boolean> }> })
      .tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_access_summary",
      "get_course_access",
      "get_dealer_access",
      "get_dimensions",
      "list_courses",
    ]);
    expect(
      tools.every((t) => t.annotations.readOnlyHint === true && t.annotations.destructiveHint === false),
    ).toBe(true);
  });

  it("list_courses hides invisible courses and names categories", async () => {
    const { payload } = await callTool(POST, "list_courses", {});
    expect(payload.tenant).toBe("gla");
    expect(payload.data.courses.map((c: { id: number }) => c.id)).not.toContain(31);
    expect(payload.data.courses.find((c: { id: number }) => c.id === 30).category.path).toBe(
      "Product Training / Advanced",
    );
  });

  it("get_access_summary returns grouped, enveloped metrics", async () => {
    const { result, payload } = await callTool(POST, "get_access_summary", {
      group_by: ["region", "level"],
      recent_days: 30,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeDefined();
    expect(payload.window.semantics).toBe("accessed_since");
    expect(payload.data.unit).toBe("people");
    const row = payload.data.rows[0];
    expect(row.group).toHaveProperty("region");
    expect(row.group).toHaveProperty("level");
    expect(row.enrolled).toBe(row.accessed + row.never_accessed);
    // rows partition the people total
    const sum = payload.data.rows.reduce((n: number, r: { enrolled: number }) => n + r.enrolled, 0);
    expect(sum).toBe(payload.data.totals.people.enrolled);
  });

  it("get_access_summary warns on past ranges", async () => {
    const { payload } = await callTool(POST, "get_access_summary", {
      since: "2026-01-01",
      until: "2026-01-31",
    });
    expect(payload.window.semantics).toBe("last_access_in_range");
    expect(payload.warnings.join(" ")).toMatch(/LAST access|most recent access/);
  });

  it("get_course_access lists dealers with identifiers and N/A for empty values", async () => {
    const { payload } = await callTool(POST, "get_course_access", {
      course_id: 10,
      status: "never_accessed",
      limit: 100,
    });
    expect(payload.data.course.name).toBe("Welcome to Great Life");
    expect(payload.data.people.every((p: { accessed: boolean }) => !p.accessed)).toBe(true);
    expect(payload.data.identifier_label).toBe("Conso ID");
    expect(payload.data.totals.never_accessed).toBe(payload.data.matched);
  });

  it("get_dealer_access resolves a dealer by Conso ID", async () => {
    const { payload } = await callTool(POST, "get_dealer_access", { identifier: "PC0100000000" });
    expect(payload.data.person.identifier).toBe("pc0100000000");
    expect(payload.data.person.counted_in_metrics).toBe(true);
    expect(payload.data.courses.length).toBeGreaterThan(0);
  });

  it("returns safe errors for invalid scope", async () => {
    const { result, payload } = await callTool(POST, "get_course_access", { course_id: 31 });
    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe("not_found");
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
