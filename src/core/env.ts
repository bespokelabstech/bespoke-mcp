import { z } from "zod";
import { loadTenant } from "@/tenants/registry";
import type { EnvironmentName, TenantConfig } from "@/tenants/schema";
import { AppError } from "./errors";

/**
 * Runtime configuration, read once per server instance from environment variables.
 *
 * Variable NAMES are identical in every deployment (tenant x environment); only values
 * differ. See docs/DEPLOYMENT.md#environment-variables.
 *
 * Startup guardrails (fail closed — the endpoint answers 500 until fixed):
 *  1. MCP_ACCESS_KEY present and >= 32 chars.
 *  2. MCP_TENANT is a known tenant; MCP_ENV is an environment that tenant defines.
 *  3. On Vercel: MCP_ENV=production only on VERCEL_ENV=production; MCP_ENV=staging only on
 *     VERCEL_ENV=preview from an allowed git branch. Prevents prod creds on previews.
 *  4. MOODLE_BASE_URL host is on the tenant's allow-list for this environment.
 *  5. The synthetic fixture data source is refused on Vercel.
 */

const MIN_KEY_LENGTH = 32;

const rawSchema = z.object({
  MCP_TENANT: z.string().min(1, "MCP_TENANT is required"),
  MCP_ENV: z.enum(["staging", "production"], { message: "MCP_ENV must be staging or production" }),
  MCP_ACCESS_KEY: z
    .string()
    .min(MIN_KEY_LENGTH, `MCP_ACCESS_KEY must be at least ${MIN_KEY_LENGTH} characters`),
  MCP_ACCESS_KEY_NEXT: z.string().min(MIN_KEY_LENGTH).optional(),
  MOODLE_BASE_URL: z.string().url().optional(),
  MOODLE_WS_TOKEN: z.string().min(1).optional(),
  MOODLE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).optional(),
  MCP_DATA_SOURCE: z.enum(["fixture"]).optional(),
  VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
  VERCEL_GIT_COMMIT_REF: z.string().optional(),
});

export interface MoodleSettings {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

export interface RuntimeConfig {
  tenant: TenantConfig;
  env: EnvironmentName;
  accessKeys: string[];
  dataSource: { kind: "moodle"; moodle: MoodleSettings } | { kind: "fixture" } | { kind: "none" };
}

/** Treat empty strings as unset (Vercel and .env files often carry `KEY=`). */
function readEnv(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of Object.keys(rawSchema.shape)) {
    const v = source[key];
    out[key] = v === undefined || v.trim() === "" ? undefined : v.trim();
  }
  return out;
}

export function parseRuntimeConfig(source: Record<string, string | undefined> = process.env): RuntimeConfig {
  const parsed = rawSchema.safeParse(readEnv(source));
  if (!parsed.success) {
    throw new AppError("not_configured", "Server environment is misconfigured.", {
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  const e = parsed.data;
  const tenant = loadTenant(e.MCP_TENANT, e.MCP_ENV);
  const envRules = tenant.environments[e.MCP_ENV]!;

  // Guardrail 3: environment <-> Vercel deployment target.
  if (e.VERCEL_ENV === "production" && e.MCP_ENV !== "production") {
    fail("MCP_ENV must be 'production' on a Vercel production deployment.");
  }
  if (e.VERCEL_ENV === "preview") {
    if (e.MCP_ENV !== "staging") fail("MCP_ENV must be 'staging' on a Vercel preview deployment.");
    const branch = e.VERCEL_GIT_COMMIT_REF ?? "";
    if (!envRules.vercelPreviewBranches.includes(branch)) {
      fail("This preview branch is not allowed to run the staging environment.", { branch });
    }
  }

  // Guardrail 5 + data source selection.
  let dataSource: RuntimeConfig["dataSource"] = { kind: "none" };
  if (e.MCP_DATA_SOURCE === "fixture") {
    if (e.VERCEL_ENV) fail("MCP_DATA_SOURCE=fixture is only allowed for local development.");
    dataSource = { kind: "fixture" };
  } else if (e.MOODLE_BASE_URL || e.MOODLE_WS_TOKEN) {
    if (!e.MOODLE_BASE_URL || !e.MOODLE_WS_TOKEN) {
      fail("MOODLE_BASE_URL and MOODLE_WS_TOKEN must be set together.");
    }
    const url = new URL(e.MOODLE_BASE_URL);
    if (url.protocol !== "https:") fail("MOODLE_BASE_URL must use https.");
    // Guardrail 4: the token may only be pointed at this environment's Moodle.
    if (!envRules.moodleAllowedHosts.includes(url.hostname)) {
      fail("MOODLE_BASE_URL host is not allowed for this tenant/environment.", { host: url.hostname });
    }
    dataSource = {
      kind: "moodle",
      moodle: {
        baseUrl: url.origin + url.pathname.replace(/\/+$/, ""),
        token: e.MOODLE_WS_TOKEN,
        timeoutMs: e.MOODLE_TIMEOUT_MS ?? 15_000,
      },
    };
  }

  const accessKeys = [e.MCP_ACCESS_KEY, e.MCP_ACCESS_KEY_NEXT].filter((k): k is string => Boolean(k));
  return { tenant, env: e.MCP_ENV, accessKeys, dataSource };
}

function fail(message: string, logFields: Record<string, unknown> = {}): never {
  throw new AppError("not_configured", message, logFields);
}

let cached: { config: RuntimeConfig } | { error: AppError } | undefined;

/** Parse once per instance; the result (or the failure) is reused for every request. */
export function getRuntimeConfig(): RuntimeConfig {
  if (!cached) {
    try {
      cached = { config: parseRuntimeConfig() };
    } catch (err) {
      cached = { error: err instanceof AppError ? err : new AppError("internal", "Config load failed.") };
    }
  }
  if ("error" in cached) throw cached.error;
  return cached.config;
}

/** Test hook. */
export function resetRuntimeConfigForTests(): void {
  cached = undefined;
}
