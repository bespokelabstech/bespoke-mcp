import { describe, expect, it } from "vitest";
import { isAuthorized } from "@/core/auth";
import { KEY } from "./helpers";

const h = (v?: string) => new Headers(v === undefined ? {} : { "x-api-key": v });

describe("x-api-key guard", () => {
  it("accepts the configured key", () => expect(isAuthorized(h(KEY), [KEY])).toBe(true));
  it("accepts the rotation key", () =>
    expect(isAuthorized(h("next".padEnd(40, "y")), [KEY, "next".padEnd(40, "y")])).toBe(true));
  it("rejects a missing header", () => expect(isAuthorized(h(), [KEY])).toBe(false));
  it("rejects a wrong key, including a prefix of the right one", () => {
    expect(isAuthorized(h("nope"), [KEY])).toBe(false);
    expect(isAuthorized(h(KEY.slice(0, 20)), [KEY])).toBe(false);
  });
  it("fails closed with no configured keys", () => expect(isAuthorized(h(KEY), [])).toBe(false));
  it("does not accept the key via Authorization", () => {
    expect(isAuthorized(new Headers({ authorization: `Bearer ${KEY}` }), [KEY])).toBe(false);
  });
});

describe("log redaction", () => {
  it("drops sensitive fields but keeps diagnostics", async () => {
    const { vi } = await import("vitest");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { log } = await import("@/core/logger");
    log.info("t", {
      token: "a",
      wstoken: "b",
      api_key: "c",
      MCP_ACCESS_KEY: "d",
      password: "e",
      arg_keys: ["x"],
      key_header_present: true,
    });
    const line = JSON.parse(String(spy.mock.calls[0]![0]));
    spy.mockRestore();
    for (const k of ["token", "wstoken", "api_key", "MCP_ACCESS_KEY", "password"])
      expect(line[k]).toBe("[redacted]");
    expect(line.arg_keys).toEqual(["x"]);
    expect(line.key_header_present).toBe(true);
  });
});
