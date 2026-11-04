import type { McpServer } from "@modelcontextprotocol/server";
import { registerDescribeCapabilities } from "./describe-capabilities";
import { registerGetPerson } from "./get-person";
import { registerListCourses } from "./list-courses";
import { registerListDimensionValues } from "./list-dimension-values";
import { registerListPeople } from "./list-people";
import { registerQueryMetrics } from "./query-metrics";
import type { ToolDeps } from "./runtime";

/**
 * Six general-purpose, read-only capabilities. They are listed even before LMS credentials
 * exist (tools then answer "not configured") so the connector can be wired up first. Future
 * ports (rewards, dealer directory) register their tools only for tenants that bind them.
 */
export function registerTools(server: McpServer, deps: ToolDeps): void {
  registerDescribeCapabilities(server, deps);
  registerListCourses(server, deps);
  registerListDimensionValues(server, deps);
  registerQueryMetrics(server, deps);
  registerListPeople(server, deps);
  registerGetPerson(server, deps);
}
