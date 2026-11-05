import { createHash } from "node:crypto";
import { createMcpHandler } from "mcp-handler";
import { FixtureLearningAdapter } from "@/connectors/fixture/adapter";
import { MoodleLearningAdapter } from "@/connectors/moodle/adapter";
import type { LearningDataPort } from "@/ports/learning";
import { registerTools } from "@/tools";
import type { ToolDeps } from "@/tools/runtime";
import type { TenantConfig } from "@/tenants/schema";
import type { RuntimeConfig } from "./env";

export const SERVER_INFO = { name: "bespoke-mcp", version: "0.3.1" };

/** Build the learning port selected by the runtime config. One instance per server instance. */
export function buildLearningPort(cfg: RuntimeConfig): LearningDataPort | null {
  switch (cfg.dataSource.kind) {
    case "moodle":
      return new MoodleLearningAdapter({
        settings: cfg.dataSource.moodle,
        pageSize: cfg.tenant.limits.participantsPageSize,
        cacheTtlSeconds: cfg.tenant.limits.cacheTtlSeconds,
        concurrency: cfg.tenant.limits.upstreamConcurrency,
      });
    case "fixture":
      return new FixtureLearningAdapter({ nowSec: Math.floor(Date.now() / 1000) });
    default:
      return null;
  }
}

export function buildInstructions(t: TenantConfig, env: string): string {
  const v = t.vocabulary;
  return [
    `Read-only access to ${t.displayName} learning data (${env}), pulled live from the LMS.`,
    `Say "${v.person}" for people and "${v.course}" for courses. By default only ${v.personPlural} with a valid ${t.identity.label} are counted; legacy and excluded accounts are reported separately.`,
    `Every number is computed by the server: report it exactly, never estimate, recompute or fill in values the server did not return (e.g. a null name).`,
    `Engagement has separate signals (see describe_capabilities): "started" (completed at least one activity; sees app use) is the best per-course signal; "site_last_access" is app/site use, not per course; "web_course_access" is web-only and misses the mobile app — never present it as course access.`,
    `Windows ending now are exact; past date ranges only count the LAST access — say so.`,
    `Profile values (${t.dimensions.region.label}, ${t.dimensions.level.label}, ${t.dimensions.branch.label}) are shown exactly as stored; "${t.emptyValueLabel}" means empty; similar-looking values are separate values — clarify, do not merge.`,
    `If query_metrics returns next_cursor, call it again with the same arguments plus the cursor until complete=true.`,
    `Mention any warnings returned with a result.`,
  ].join(" ");
}

export type McpRequestHandler = (req: Request) => Promise<Response>;

export function buildMcpHandler(cfg: RuntimeConfig, learning: LearningDataPort | null): McpRequestHandler {
  const deps: ToolDeps = {
    tenant: cfg.tenant,
    env: cfg.env,
    learning,
    nowSec: () => Math.floor(Date.now() / 1000),
    // Cursor signing key: derived, so the access key itself never signs anything visible.
    cursorSecret: createHash("sha256")
      .update(`cursor:${cfg.accessKeys[0] ?? ""}`)
      .digest("base64url"),
  };
  return createMcpHandler((server) => registerTools(server, deps), {
    serverInfo: SERVER_INFO,
    instructions: buildInstructions(cfg.tenant, cfg.env),
  });
}
