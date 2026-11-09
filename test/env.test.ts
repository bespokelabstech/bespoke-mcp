import { describe, expect, it } from "vitest";
import { parseRuntimeConfig } from "@/core/env";
import { KEY } from "./helpers";

const base = { MCP_TENANT: "gla", MCP_ENV: "staging", MCP_ACCESS_KEY: KEY } as Record<
  string,
  string | undefined
>;
const parse = (extra: Record<string, string | undefined>) => parseRuntimeConfig({ ...base, ...extra });

describe("runtime config guardrails", () => {
  it("loads gla staging with no LMS configured", () => {
    const cfg = parse({});
    expect(cfg.tenant.id).toBe("gla");
    expect(cfg.dataSource.kind).toBe("none");
    // base scope and the default saved filter survive the overlay merge
    expect(cfg.tenant.accounts.nonLearnerRoles).toContain("redemptionmanager");
    expect(cfg.tenant.defaults.savedFilter).toBe("valid_dealers");
    expect(cfg.tenant.defaults.exclude.level).toEqual(["PC Center of Excellence"]);
  });

  it("requires a long access key", () => {
    expect(() => parse({ MCP_ACCESS_KEY: "short" })).toThrow(/misconfigured/);
  });

  it("rejects unknown tenants", () => {
    expect(() => parse({ MCP_TENANT: "nope" })).toThrow(/Unknown tenant/);
  });

  it("accepts the allowed staging Moodle host and normalises the URL", () => {
    const cfg = parse({ MOODLE_BASE_URL: "https://gla-staging.bihasa.ph/", MOODLE_WS_TOKEN: "t" });
    expect(cfg.dataSource).toMatchObject({
      kind: "moodle",
      moodle: { baseUrl: "https://gla-staging.bihasa.ph" },
    });
  });

  it("refuses a production Moodle host in staging", () => {
    expect(() => parse({ MOODLE_BASE_URL: "https://gla.bihasa.ph", MOODLE_WS_TOKEN: "t" })).toThrow(
      /not allowed/,
    );
  });

  it("refuses http and half-configured Moodle settings", () => {
    expect(() => parse({ MOODLE_BASE_URL: "http://gla-staging.bihasa.ph", MOODLE_WS_TOKEN: "t" })).toThrow(
      /https/,
    );
    expect(() => parse({ MOODLE_BASE_URL: "https://gla-staging.bihasa.ph" })).toThrow(/together/);
  });

  it("ties MCP_ENV to the Vercel target and branch", () => {
    expect(() => parse({ VERCEL_ENV: "production" })).toThrow(/production/);
    expect(() => parse({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature/x" })).toThrow(/branch/);
    expect(parse({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "release" }).env).toBe("staging");
    expect(() =>
      parseRuntimeConfig({
        ...base,
        MCP_ENV: "production",
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_REF: "release",
      }),
    ).toThrow();
    expect(parseRuntimeConfig({ ...base, MCP_ENV: "production", VERCEL_ENV: "production" }).env).toBe(
      "production",
    );
  });

  it("refuses fixture data on Vercel", () => {
    expect(parse({ MCP_DATA_SOURCE: "fixture" }).dataSource.kind).toBe("fixture");
    expect(() =>
      parse({ MCP_DATA_SOURCE: "fixture", VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "release" }),
    ).toThrow(/local/);
  });

  it("treats empty strings as unset", () => {
    expect(parse({ MOODLE_BASE_URL: "", MOODLE_WS_TOKEN: "  " }).dataSource.kind).toBe("none");
  });
});
