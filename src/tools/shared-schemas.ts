import { z } from "zod";
import type { Status } from "@/domain/people";
import type { StatusCounts } from "@/domain/population";
import { SIGNAL_IDS } from "@/domain/signals";
import type { TenantConfig } from "@/tenants/schema";

/** Input fragments shared by several tools. Descriptions use the tenant's vocabulary. */

export function scopeFields(t: TenantConfig) {
  const c = t.vocabulary.coursePlural.toLowerCase();
  return {
    course_ids: z
      .array(z.number().int().positive())
      .max(200)
      .optional()
      .describe(`Limit to these ${c} (ids from list_courses). Omit for all ${c} in scope.`),
    category_ids: z
      .array(z.number().int().positive())
      .max(50)
      .optional()
      .describe(`Limit to ${c} in these categories (sub-categories included).`),
  };
}

export function filtersField(t: TenantConfig) {
  const d = t.dimensions;
  const list = (label: string, extra = "") =>
    z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe(
        `${label} values to keep (case-insensitive, exact match on the stored value). Use "${t.emptyValueLabel}" for empty.${extra}`,
      );
  return z
    .object({
      region: list(
        d.region.label,
        ' Similar-looking values (e.g. "Visayas" and "Visayas 1") are different values.',
      ),
      level: list(d.level.label),
      branch: list(d.branch.label, " Matches the full label, the branch name, or the branch code."),
    })
    .optional()
    .describe(`Restrict to people with these profile values. Get valid values from list_dimension_values.`);
}

export function windowFields(t: TenantConfig) {
  return {
    recent_days: z
      .number()
      .int()
      .min(1)
      .max(3650)
      .optional()
      .describe("Rolling window ending now for time-based signals, e.g. 30 = in the last 30 days. Exact."),
    since: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(`Window start date YYYY-MM-DD (${t.timezone}). Without a past 'until' this is exact.`),
    until: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        "Window end date YYYY-MM-DD, inclusive. If in the past, only people whose LAST access fell in the range are counted (the LMS keeps only the latest access) — say so when reporting.",
      ),
  };
}

export const dimensionEnum = z.enum(["region", "level", "branch"]);

export const signalsField = z
  .array(z.enum(SIGNAL_IDS))
  .min(1)
  .max(5)
  .optional()
  .describe(
    "Which engagement signals to compute (see describe_capabilities). Default: started + site_last_access. " +
      "web_course_access is web-only and misses mobile-app use.",
  );

// ---------------------------------------------------------------- population (statuses)

/** Population values are the tenant's own words: e.g. "dealer", "legacy", "excluded". */
export function populationValues(t: TenantConfig): [string, string, string] {
  return [t.vocabulary.personKey, "legacy", "excluded"];
}

export function populationField(t: TenantConfig) {
  const [person] = populationValues(t);
  return z
    .array(z.enum(populationValues(t)))
    .min(1)
    .max(3)
    .optional()
    .describe(
      `Which accounts to count. ${person} = valid ${t.identity.label} (default); ` +
        `legacy = no ${t.identity.label} or an old/malformed format; excluded = test, dummy, staff or non-learner accounts. ` +
        `Combine, e.g. ["${person}","legacy"].`,
    );
}

export function toStatuses(values: string[] | undefined, t: TenantConfig): Status[] {
  const [person] = populationValues(t);
  return (values ?? [person]).map((v) => (v === person ? "person" : (v as Status)));
}

export function statusLabel(s: Status, t: TenantConfig): string {
  return s === "person" ? t.vocabulary.personKey : s;
}

/** {dealer, legacy, excluded} plus, when duplicates merged, dealer_duplicate_accounts_merged. */
export function labelledCounts(
  c: StatusCounts,
  t: TenantConfig,
  mergedDuplicates = 0,
): Record<string, number> {
  return {
    [t.vocabulary.personKey]: c.person,
    legacy: c.legacy,
    excluded: c.excluded,
    ...(mergedDuplicates > 0
      ? { [`${t.vocabulary.personKey}_duplicate_accounts_merged`]: mergedDuplicates }
      : {}),
  };
}
