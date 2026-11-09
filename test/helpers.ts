import type { AccountInput } from "@/domain/people";
import { loadTenant } from "@/tenants/registry";

export const KEY = "test-key-".padEnd(40, "x");
export const glaStaging = () => loadTenant("gla", "staging");

export function account(over: Partial<AccountInput> & { userId: number }): AccountInput {
  return {
    username: `0101${String(over.userId).padStart(8, "0")}`,
    firstName: "Juan",
    lastName: String(over.userId),
    profile: {},
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
