import type { PersonView } from "@/domain/people";
import { dimensionValue } from "@/domain/people";
import type { TenantConfig } from "@/tenants/schema";
import { DIMENSION_IDS } from "@/tenants/schema";

/** Warnings shared by several tools for known gaps against the BES-465 definitions. */
export function regionSourceNote(t: TenantConfig): string {
  return (
    `${t.dimensions.region.label} is the value stored on each profile, not the region of the ` +
    `${t.dimensions.branch.label.toLowerCase()} in Branches & Regions; the two can differ.`
  );
}

/**
 * Warnings when a saved-filter rule could not really be applied, or a value is unexpected:
 *  - the filter has an email/status rule but the LMS showed no email domain / suspension flag
 *    for any account (Moodle hides them from the service account) — those rules match nobody;
 *  - a dimension value outside the tenant's expected values (e.g. a 5th Dealer Level).
 */
export function dataWarnings(t: TenantConfig, persons: Iterable<PersonView>): string[] {
  const list = [...new Map([...persons].map((p) => [p.userId, p])).values()];
  const out: string[] = [];
  const sf = t.defaults.savedFilter ? t.savedFilters[t.defaults.savedFilter] : undefined;
  if (sf && list.length >= 5) {
    const uses = (field: string) => sf.hide.filter((c) => c.field === field).map((c) => `"${c.label}"`);
    const email = uses("email");
    if (email.length && !list.some((p) => p.emailKnown)) {
      out.push(
        `Email addresses are not visible to the LMS service account, so rule ${email.join(", ")} was not applied: ` +
          `accounts it should hide may be counted as ${sf.label}.`,
      );
    }
    const status = uses("status");
    if (status.length && !list.some((p) => p.statusKnown)) {
      out.push(
        `Account status is not visible to the LMS service account, so rule ${status.join(", ")} was not applied.`,
      );
    }
  }
  for (const dim of DIMENSION_IDS) {
    const expected = t.dimensions[dim].expectedValues;
    if (!expected.length) continue;
    const known = new Set(expected.map((v) => v.trim().toLowerCase()));
    const odd = [
      ...new Set(
        list
          .map((p) => dimensionValue(p, dim))
          .filter((v) => v !== t.emptyValueLabel && !known.has(v.trim().toLowerCase())),
      ),
    ].sort();
    if (odd.length) {
      out.push(
        `Unexpected ${t.dimensions[dim].label} value(s) ${odd.map((v) => `"${v}"`).join(", ")}: ` +
          "not one of the known values, and not hidden by any rule — check whether they should count.",
      );
    }
  }
  return out;
}
