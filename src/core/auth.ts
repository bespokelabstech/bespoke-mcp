import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Shared-key authentication for the POC (docs/DECISIONS.md ADR-003).
 *
 * Claude's custom connector sends a fixed `x-api-key` request header (configured by an
 * org Owner under "Request headers"). We compare SHA-256 digests in constant time so
 * neither the key length nor its prefix leaks through timing.
 *
 * The 401 deliberately carries NO `WWW-Authenticate` challenge: a challenge would make
 * Claude start OAuth discovery, which this server does not offer.
 */
export const API_KEY_HEADER = "x-api-key";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function isAuthorized(headers: Headers, acceptedKeys: readonly string[]): boolean {
  const presented = headers.get(API_KEY_HEADER);
  if (!presented || acceptedKeys.length === 0) return false;
  const p = digest(presented);
  let ok = false;
  // Check every key (no early exit) so timing does not reveal which key matched.
  for (const key of acceptedKeys) {
    if (timingSafeEqual(p, digest(key))) ok = true;
  }
  return ok;
}

export function unauthorizedResponse(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}
