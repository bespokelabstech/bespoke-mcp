import type { McpServer } from "@modelcontextprotocol/server";
import { registerGetAccessSummary } from "./get-access-summary";
import { registerGetCourseAccess } from "./get-course-access";
import { registerGetDimensions } from "./get-dimensions";
import { registerGetPersonAccess } from "./get-person-access";
import { registerListCourses } from "./list-courses";
import type { ToolDeps } from "./runtime";

/**
 * Register the tools this tenant supports. Learning tools are always listed (they report
 * "not configured" until the LMS credentials exist) so the connector can be wired up and
 * tested in Claude before the LMS token is issued. Future capability ports (rewards,
 * dealer directory) register their tools only when the tenant binds that port.
 */
export function registerTools(server: McpServer, deps: ToolDeps): void {
  registerListCourses(server, deps);
  registerGetDimensions(server, deps);
  registerGetAccessSummary(server, deps);
  registerGetCourseAccess(server, deps);
  registerGetPersonAccess(server, deps);
}
