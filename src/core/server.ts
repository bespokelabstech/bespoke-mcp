import { createMcpHandler } from "mcp-handler";
import { FixtureLearningAdapter } from "@/connectors/fixture/adapter";
import { MoodleLearningAdapter } from "@/connectors/moodle/adapter";
import type { LearningDataPort } from "@/ports/learning";
import { registerTools } from "@/tools";
import type { ToolDeps } from "@/tools/runtime";
import type { TenantConfig } from "@/tenants/schema";
import type { RuntimeConfig } from "./env";

export const SERVER_INFO = { name: "bespoke-mcp", version: "0.1.0" };

/** Build the learning port selected by the runtime config. One instance per server instance. */
export function buildLearningPort(cfg: RuntimeConfig): LearningDataPort | null {
  switch (cfg.dataSource.kind) {
    case "moodle":
      return new MoodleLearningAdapter({
        settings: cfg.dataSource.moodle,
        pageSize: cfg.tenant.limits.participantsPageSize,
        cacheTtlSeconds: cfg.tenant.limits.cacheTtlSeconds,
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
    `Read-only access to ${t.displayName} learning data (${env}).`,
    `Say "${v.person}" for people and "${v.course}" for courses.`,
    `Every metric is computed by the server from live LMS records; report numbers exactly as returned and never estimate or recompute them.`,
    `"Accessed" means the LMS has a recorded last access to the ${v.course.toLowerCase()}. Windows ending now are exact; windows ending in the past only count people whose LAST access fell inside — always say so when you report them.`,
    `Profile values (${t.dimensions.region.label}, ${t.dimensions.level.label}, ${t.dimensions.branch.label}) are shown exactly as stored; "${t.emptyValueLabel}" means empty. Call get_dimensions before filtering if unsure of a value.`,
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
  };
  return createMcpHandler((server) => registerTools(server, deps), {
    serverInfo: SERVER_INFO,
    instructions: buildInstructions(cfg.tenant, cfg.env),
  });
}
