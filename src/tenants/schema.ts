import { z } from "zod";

/**
 * Tenant configuration: everything client-specific that is NOT a secret.
 * It is code (reviewed in PRs, type-checked, tested). Secrets live only in
 * environment variables; this file may reference env var *names*, never values.
 *
 * A tenant = one client's data scope. Each deployment (Vercel project + environment)
 * serves exactly one tenant and one environment overlay.
 */

/**
 * Fields a saved filter may use (BES-465): account identity fields plus Dealer Level, a
 * deliberate exception. Region, branch and category are not allowed. Values are trimmed and
 * lower-cased before matching:
 *   username, conso_id (profile value as stored, "" when empty), name ("first last", "" when
 *   blank), email (the "@domain" only), status ("active" | "suspended" | "" when not shown),
 *   level (stored value, "" when empty).
 */
export const SAVED_FILTER_FIELDS = ["username", "conso_id", "name", "email", "status", "level"] as const;
export type SavedFilterField = (typeof SAVED_FILTER_FIELDS)[number];

export const conditionSchema = z
  .object({
    field: z.enum(SAVED_FILTER_FIELDS),
    op: z.enum(["in", "not_in", "matches", "equals"]),
    /** in / not_in: a list; equals: one value; matches: a regular expression. */
    value: z.union([z.string(), z.array(z.string()).min(1)]),
    /** Short reason shown when an account is hidden by this condition, e.g. "Dummy Conso ID". */
    label: z.string().min(1),
  })
  .superRefine((c, ctx) => {
    const list = Array.isArray(c.value);
    if ((c.op === "in" || c.op === "not_in") !== list) {
      ctx.addIssue({ code: "custom", message: `${c.op} takes ${list ? "one value" : "a list"}` });
    }
    if (c.op === "matches" && typeof c.value === "string") {
      try {
        new RegExp(c.value);
      } catch {
        ctx.addIssue({ code: "custom", message: `invalid regular expression: ${c.value}` });
      }
    }
  });
export type Condition = z.infer<typeof conditionSchema>;

export const dimensionSchema = z.object({
  /** Human label used in tool descriptions and outputs, e.g. "Dealer Level". */
  label: z.string().min(1),
  /** Custom user profile field shortname in the LMS, e.g. "level". */
  profileField: z.string().min(1),
  /**
   * How to read the value:
   *  - "verbatim": the stored value is the display value;
   *  - "name_with_code": values look like "NAME (0032)"; name and code are also exposed
   *    for filtering, while the stored value remains the display label.
   */
  format: z.enum(["verbatim", "name_with_code"]).default("verbatim"),
  /** Known values; any other non-empty value seen in an answer produces a warning. Empty = no check. */
  expectedValues: z.array(z.string()).default([]),
});

export const tenantConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  displayName: z.string().min(1),
  /** IANA zone used for all date inputs/outputs, e.g. "Asia/Manila". */
  timezone: z.string().min(1),

  /** Words the client uses. Drives tool names/descriptions and server instructions. */
  vocabulary: z.object({
    /** Singular noun for an eligible learner, e.g. "Dealer". */
    person: z.string().min(1),
    personPlural: z.string().min(1),
    course: z.string().min(1),
    coursePlural: z.string().min(1),
  }),

  /** Value shown when a profile attribute is empty. */
  emptyValueLabel: z.string().default("N/A"),
  /** Placeholder text typed into a profile field that means "none" (case-insensitive) — treated as empty. */
  placeholderValues: z.array(z.string()).default(["n/a", "na", "none", "null", "nil", "-"]),

  /** Business dimensions, keyed by a stable dimension id used in tool inputs. */
  dimensions: z.object({
    region: dimensionSchema,
    level: dimensionSchema,
    branch: dimensionSchema,
  }),

  /** How a person is identified across systems (e.g. Conso ID). Read as stored; never repaired. */
  identity: z.object({
    label: z.string().min(1),
    /** Profile field holding the identifier; may be empty or malformed on legacy accounts. */
    profileField: z.string().min(1),
  }),

  /**
   * Base scope — always applied, not a filter: only learner accounts count. An enrolment counts
   * when the account holds a learner role in that course and none of the non-learner roles.
   */
  accounts: z.object({
    learnerRoles: z.array(z.string().min(1)).min(1),
    nonLearnerRoles: z.array(z.string().min(1)).default([]),
  }),

  /**
   * Saved filters (e.g. "valid_dealers"): a named list of rules. An account matching AT LEAST
   * ONE rule is hidden while the filter is on (BES-465). Fields: SAVED_FILTER_FIELDS.
   */
  savedFilters: z
    .record(
      z.string().regex(/^[a-z][a-z0-9_]*$/),
      z.object({
        label: z.string().min(1),
        /** True while the client has not confirmed the rules. Shown in describe_capabilities. */
        provisional: z.boolean().default(false),
        note: z.string().optional(),
        /** Hide an account that matches at least one of these rules. */
        hide: z.array(conditionSchema).min(1),
      }),
    )
    .default({}),

  /** Defaults applied when the caller does not set them (BES-465: every other filter is "all"). */
  defaults: z
    .object({
      /** Saved filter that is ON by default (the caller can switch it off). null = none. */
      savedFilter: z.string().nullable().default(null),
    })
    .default({ savedFilter: null }),

  /** Which graded items count towards avg_score. */
  scoring: z.object({ itemModules: z.array(z.string().min(1)).min(1) }).default({ itemModules: ["quiz"] }),

  courses: z.object({
    /** Category ids (and their sub-categories) in scope. Empty = all categories. */
    includeCategoryIds: z.array(z.number().int().positive()).default([]),
    excludeCourseIds: z.array(z.number().int().positive()).default([]),
  }),

  limits: z.object({
    /** Max courses one aggregate request may cover before asking the user to narrow it. */
    maxCoursesPerRequest: z.number().int().positive(),
    /** Page size for paged participant pulls. */
    participantsPageSize: z.number().int().min(50).max(2000),
    /** list_people: max accounts for filtering/sorting by a per-person signal (query_metrics batches instead). */
    maxPeopleForPersonSignals: z.number().int().positive(),
    /** Max concurrent upstream calls per request. */
    upstreamConcurrency: z.number().int().min(1).max(16),
    /** Wall-clock budget per tool call (ms); must stay below the function maxDuration. */
    requestBudgetMs: z.number().int().min(5_000).max(280_000),
    /** In-memory cache TTL for course lists and participant pulls (seconds). */
    cacheTtlSeconds: z.number().int().min(0).max(3600),
  }),

  /** Per-environment guardrails, checked at startup. */
  environments: z.record(
    z.enum(["staging", "production"]),
    z.object({
      /** MOODLE_BASE_URL host must be one of these, or the server refuses to start. */
      moodleAllowedHosts: z.array(z.string().min(1)).min(1),
      /** On Vercel preview deployments: git branches allowed to run this environment. */
      vercelPreviewBranches: z.array(z.string()).default([]),
    }),
  ),
});

export type TenantConfig = z.infer<typeof tenantConfigSchema>;
export type TenantConfigInput = z.input<typeof tenantConfigSchema>;
export type DimensionId = keyof TenantConfig["dimensions"];
export const DIMENSION_IDS = ["region", "level", "branch"] as const satisfies readonly DimensionId[];
export type EnvironmentName = "staging" | "production";

/** Partial overlay applied on top of a tenant base for one environment. */
export type TenantOverlay = DeepPartial<TenantConfigInput>;
type DeepPartial<T> = T extends unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
