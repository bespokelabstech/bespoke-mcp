/**
 * Deep-merge an environment overlay onto a tenant base.
 * Objects merge recursively; arrays and scalars in the overlay REPLACE the base value
 * (so an overlay never silently appends to an exclusion list — it states the full list).
 */
export function mergeOverlay<T>(base: T, overlay: unknown): T {
  if (overlay === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(overlay)) return overlay as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    out[k] = mergeOverlay((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
