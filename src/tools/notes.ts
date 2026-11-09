import type { TenantConfig } from "@/tenants/schema";

/** Warnings shared by several tools for known gaps against the BES-465 definitions. */
export function regionSourceNote(t: TenantConfig): string {
  return (
    `${t.dimensions.region.label} is the value stored on each profile, not the region of the ` +
    `${t.dimensions.branch.label.toLowerCase()} in Branches & Regions; the two can differ.`
  );
}
