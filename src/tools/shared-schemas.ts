import { z } from "zod";
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
        `${label} values to keep (case-insensitive, exact). Use "${t.emptyValueLabel}" for empty.${extra}`,
      );
  return z
    .object({
      region: list(d.region.label),
      level: list(d.level.label),
      branch: list(d.branch.label, " Matches the full label, the branch name, or the branch code."),
    })
    .optional()
    .describe(
      `Restrict to ${t.vocabulary.personPlural.toLowerCase()} with these profile values. Get valid values from get_dimensions.`,
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
      .describe("Rolling window ending now, e.g. 30 = accessed in the last 30 days. Exact."),
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
        "Window end date YYYY-MM-DD, inclusive. If in the past, the result only counts people whose LAST access fell in the range (the LMS keeps only the latest access) — say so when reporting.",
      ),
  };
}

export const dimensionEnum = z.enum(["region", "level", "branch"]);
