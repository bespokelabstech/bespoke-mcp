import { loadTenant } from "@/tenants/registry";
import type { Participant } from "@/ports/learning";

export const KEY = "test-key-".padEnd(40, "x");
export const glaStaging = () => loadTenant("gla", "staging");

export function participant(over: Partial<Participant> & { userId: number }): Participant {
  return {
    username: `pc${String(over.userId).padStart(10, "0")}`,
    firstName: "Test",
    lastName: String(over.userId),
    courseRoles: ["student"],
    profile: {},
    lastCourseAccess: null,
    ...over,
  };
}

/** Parse a Streamable-HTTP response (JSON or single-message SSE) into the JSON-RPC payload. */
export async function rpcBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    return JSON.parse(line!.slice(5));
  }
  return JSON.parse(text);
}
