import type { PersonView } from "@/domain/people";
import { dimensionValue } from "@/domain/people";
import type { DimensionId, TenantConfig } from "@/tenants/schema";
import { DIMENSION_IDS } from "@/tenants/schema";

/** Warnings shared by several tools for known gaps against the BES-465 definitions. */
export function regionSourceNote(t: TenantConfig): string {
  return (
    `${t.dimensions.region.label} is the value stored on each profile, not the region of the ` +
    `${t.dimensions.branch.label.toLowerCase()} in Branches & Regions; the two can differ.`
  );
}

/**
 * Facts behind the data warnings, additive so answers in parts can carry them in the cursor:
 *  - accounts whose email domain / suspension flag the LMS did not show (a saved-filter rule on
 *    that field cannot hide them — e.g. Moodle shows an email only when the account allows it,
 *    unless the service role may see user identity fields);
 *  - dimension values outside the tenant's expected values (e.g. a 5th Dealer Level).
 */
export interface DataFacts {
  /** Accounts checked. */
  n: number;
  noEmail: number;
  noStatus: number;
  odd: Partial<Record<DimensionId, string[]>>;
}

export function emptyFacts(): DataFacts {
  return { n: 0, noEmail: 0, noStatus: 0, odd: {} };
}

export function dataFacts(t: TenantConfig, persons: Iterable<PersonView>): DataFacts {
  const list = [...new Map([...persons].map((p) => [p.userId, p])).values()];
  const odd: DataFacts["odd"] = {};
  for (const dim of DIMENSION_IDS) {
    const expected = t.dimensions[dim].expectedValues;
    if (!expected.length) continue;
    const known = new Set(expected.map((v) => v.trim().toLowerCase()));
    const values = [
      ...new Set(
        list
          .map((p) => dimensionValue(p, dim))
          .filter((v) => v !== t.emptyValueLabel && !known.has(v.trim().toLowerCase())),
      ),
    ];
    if (values.length) odd[dim] = values;
  }
  return {
    n: list.length,
    noEmail: list.filter((p) => !p.emailKnown).length,
    noStatus: list.filter((p) => !p.statusKnown).length,
    odd,
  };
}

export function mergeFacts(a: DataFacts, b: DataFacts): DataFacts {
  const odd: DataFacts["odd"] = { ...a.odd };
  for (const [dim, values] of Object.entries(b.odd) as Array<[DimensionId, string[]]>) {
    odd[dim] = [...new Set([...(odd[dim] ?? []), ...values])];
  }
  return { n: a.n + b.n, noEmail: a.noEmail + b.noEmail, noStatus: a.noStatus + b.noStatus, odd };
}

export function factWarnings(t: TenantConfig, f: DataFacts): string[] {
  const out: string[] = [];
  const sf = t.defaults.savedFilter ? t.savedFilters[t.defaults.savedFilter] : undefined;
  if (sf && f.n > 0) {
    const uses = (field: string) => sf.hide.filter((c) => c.field === field).map((c) => `"${c.label}"`);
    const email = uses("email");
    if (email.length && f.noEmail > 0) {
      out.push(
        `Email addresses were not visible for ${f.noEmail === f.n ? "any" : `${f.noEmail} of ${f.n}`} accounts checked, ` +
          `so rule ${email.join(", ")} could not hide them: accounts it should hide may be counted as ${sf.label}.`,
      );
    }
    const status = uses("status");
    if (status.length && f.noStatus > 0) {
      out.push(
        `Account status was not visible for ${f.noStatus === f.n ? "any" : `${f.noStatus} of ${f.n}`} accounts checked, ` +
          `so rule ${status.join(", ")} could not hide them.`,
      );
    }
  }
  for (const [dim, values] of Object.entries(f.odd) as Array<[DimensionId, string[]]>) {
    out.push(
      `Unexpected ${t.dimensions[dim].label} value(s) ${[...values]
        .sort()
        .map((v) => `"${v}"`)
        .join(
          ", ",
        )}: not one of the known values, and not hidden by any rule — check whether they should count.`,
    );
  }
  return out;
}

export function dataWarnings(t: TenantConfig, persons: Iterable<PersonView>): string[] {
  return factWarnings(t, dataFacts(t, persons));
}
