import { z } from "zod";
import type { DimensionValues, Filters } from "@/domain/people";
import type { PopulationCounts } from "@/domain/population";
import { SIGNAL_IDS } from "@/domain/signals";
import type { DimensionId, TenantConfig } from "@/tenants/schema";
import { DIMENSION_IDS } from "@/tenants/schema";

/**
 * Input fragments shared by several tools — one filter contract (same names, defaults and
 * semantics as the BES-465 reporting API). Descriptions use the tenant's vocabulary.
 */

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
      .describe(`Category filter: keep ${c} in these categories (sub-categories included).`),
    exclude_category_ids: z
      .array(z.number().int().positive())
      .max(50)
      .optional()
      .describe(`Category exclude list: drop ${c} in these categories (sub-categories included).`),
  };
}

function dimensionLists(t: TenantConfig, verb: "keep" | "drop") {
  const d = t.dimensions;
  const list = (label: string, extra = "") =>
    z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe(
        `${label} values to ${verb} (case-insensitive, exact match on the stored value). Use "${t.emptyValueLabel}" for empty.${extra}`,
      );
  return z.object({
    region: list(
      d.region.label,
      ' Similar-looking values (e.g. "Visayas" and "Visayas 1") are different values.',
    ),
    level: list(d.level.label),
    branch: list(d.branch.label, " Matches the full label, the branch name, or the branch code."),
  });
}

export function filtersField(t: TenantConfig) {
  return dimensionLists(t, "keep")
    .optional()
    .describe(
      "Include lists: keep only accounts with these profile values. Get real values from list_dimension_values.",
    );
}

export function excludeField(t: TenantConfig) {
  const defaults = defaultExcludes(t);
  const note = defaults.length
    ? ` Default when you set neither filters nor exclude for that dimension: ${defaults.join("; ")}. Pass an empty list (e.g. level: []) to include them.`
    : "";
  return dimensionLists(t, "drop")
    .optional()
    .describe(`Exclude lists: drop accounts with these profile values.${note}`);
}

function defaultExcludes(t: TenantConfig): string[] {
  return DIMENSION_IDS.filter((dim) => t.defaults.exclude[dim].length).map(
    (dim) => `${t.dimensions[dim].label} not ${t.defaults.exclude[dim].map((v) => `"${v}"`).join(", ")}`,
  );
}

export function validOnlyField(t: TenantConfig) {
  const f = savedFilter(t);
  return z
    .boolean()
    .optional()
    .describe(
      f
        ? `true (default) = only ${f.label} (the "${t.defaults.savedFilter}" saved filter; see describe_capabilities). ` +
            `false = every learner account, including accounts that fail it (e.g. dummy IDs).`
        : "No saved filter is configured for this deployment: every learner account is counted.",
    );
}

export function windowFields(t: TenantConfig) {
  return {
    recent_days: z
      .number()
      .int()
      .min(1)
      .max(3650)
      .optional()
      .describe("Rolling date range ending now, e.g. 30 = the last 30 days. Exact for Logged in."),
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        `Range start YYYY-MM-DD (${t.timezone}, midnight to midnight). Without a past 'to' this is exact.`,
      ),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        "Range end YYYY-MM-DD, inclusive. If in the past, only accounts whose LAST sign-in fell in the range are counted (the LMS keeps only the latest) — say so when reporting. Accessed is never limited by a date range.",
      ),
  };
}

export const signalsField = z
  .array(z.enum(SIGNAL_IDS))
  .min(1)
  .max(5)
  .optional()
  .describe(
    "Metrics to compute (see describe_capabilities). Default: accessed + logged_in. " +
      "web_course_access is web-only and misses mobile-app use.",
  );

// ---------------------------------------------------------------- resolving the filter contract

export function savedFilter(t: TenantConfig) {
  return t.defaults.savedFilter ? (t.savedFilters[t.defaults.savedFilter] ?? null) : null;
}

export interface FilterArgs {
  filters?: DimensionValues | undefined;
  exclude?: DimensionValues | undefined;
  valid_only?: boolean | undefined;
  category_ids?: number[] | undefined;
  exclude_category_ids?: number[] | undefined;
}

export interface ResolvedFilters {
  filters: Filters;
  validOnly: boolean;
  /** What was applied, for the response envelope. */
  applied: Record<string, unknown>;
}

/**
 * Apply defaults: the saved filter is on unless valid_only=false; a dimension's default exclude
 * list applies only when the caller set neither an include nor an exclude list for it.
 * `listing` = the dimension whose values are being listed (its default is not applied).
 */
export function resolveFilters(args: FilterArgs, t: TenantConfig, listing?: DimensionId): ResolvedFilters {
  const exclude: DimensionValues = {};
  const defaultsApplied: string[] = [];
  for (const dim of DIMENSION_IDS) {
    const given = args.exclude?.[dim];
    if (given !== undefined) exclude[dim] = given;
    else if (!args.filters?.[dim]?.length && dim !== listing && t.defaults.exclude[dim].length) {
      exclude[dim] = t.defaults.exclude[dim];
      defaultsApplied.push(`exclude.${dim}`);
    }
  }
  const sf = savedFilter(t);
  const validOnly = sf !== null && args.valid_only !== false;
  const include = Object.fromEntries(
    Object.entries(args.filters ?? {}).filter(([, v]) => v && v.length),
  ) as DimensionValues;
  const nonEmptyExclude = Object.fromEntries(
    Object.entries(exclude).filter(([, v]) => v && v.length),
  ) as DimensionValues;
  return {
    filters: { include, exclude: nonEmptyExclude },
    validOnly,
    applied: {
      saved_filter: validOnly ? t.defaults.savedFilter : null,
      ...(Object.keys(include).length ? { include } : {}),
      ...(Object.keys(nonEmptyExclude).length ? { exclude: nonEmptyExclude } : {}),
      ...(args.category_ids?.length ? { category_ids: args.category_ids } : {}),
      ...(args.exclude_category_ids?.length ? { exclude_category_ids: args.exclude_category_ids } : {}),
      ...(defaultsApplied.length ? { defaults_applied: defaultsApplied } : {}),
    },
  };
}

/**
 * Population counts as returned to callers, e.g.
 * { learner_accounts: 812, valid_dealers: 790, not_valid: { "Dummy Conso ID": 22 }, counted: "valid_dealers" }.
 */
export function populationOut(
  c: PopulationCounts,
  t: TenantConfig,
  validOnly: boolean,
): Record<string, unknown> {
  const key = t.defaults.savedFilter;
  if (!key || !savedFilter(t)) return { learner_accounts: c.all, counted: "all" };
  return {
    learner_accounts: c.all,
    [key]: c.valid,
    ...(Object.keys(c.notValid).length ? { not_valid: c.notValid } : {}),
    counted: validOnly ? key : "all",
  };
}
