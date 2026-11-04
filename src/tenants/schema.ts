import { z } from "zod";

/**
 * Tenant configuration: everything client-specific that is NOT a secret.
 * It is code (reviewed in PRs, type-checked, tested). Secrets live only in
 * environment variables; this file may reference env var *names*, never values.
 *
 * A tenant = one client's data scope. Each deployment (Vercel project + environment)
 * serves exactly one tenant and one environment overlay.
 */

const usernameRange = z.tuple([z.string().min(1), z.string().min(1)]);

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
    /** snake_case key for the counted population, e.g. "dealer" (population: ["dealer", "legacy"]). */
    personKey: z.string().regex(/^[a-z][a-z0-9_]*$/),
    course: z.string().min(1),
    coursePlural: z.string().min(1),
  }),

  /** Value shown when a profile attribute is empty. */
  emptyValueLabel: z.string().default("N/A"),

  /** Business dimensions, keyed by a stable dimension id used in tool inputs. */
  dimensions: z.object({
    region: dimensionSchema,
    level: dimensionSchema,
    branch: dimensionSchema,
  }),

  /** How a person is identified across systems (e.g. Conso ID). */
  identity: z.object({
    label: z.string().min(1),
    /** Profile field holding the identifier; may be empty or malformed on legacy accounts. */
    profileField: z.string().min(1),
    /** A normalised identifier matching this is structurally valid. */
    validPattern: z.string().min(1),
    /** Numeric identifiers of this length are left-padded with zeros to `padNumericTo`. */
    padNumericFrom: z.number().int().positive().optional(),
    padNumericTo: z.number().int().positive().optional(),
  }),

  /**
   * Who counts. Every enrolled account gets exactly one status:
   *   person   — structurally valid identifier, not excluded (counted, e.g. "Dealer");
   *   legacy   — no identifier, or one in an old/malformed format (shown, not counted);
   *   excluded — test, dummy, staff or non-learner role (shown, not counted).
   */
  eligibility: z.object({
    /** Must hold at least one of these course roles to be a learner at all. */
    requiredCourseRoles: z.array(z.string()).min(1),
    /** Label for the `legacy` status, e.g. "Legacy". */
    legacyLabel: z.string().min(1),
    exclude: z.object({
      usernames: z.array(z.string()).default([]),
      /** Inclusive [from, to]; numeric strings of equal length compare numerically. */
      usernameRanges: z.array(usernameRange).default([]),
      courseRoles: z.array(z.string()).default([]),
      /** Values of the `level` dimension that mark staff, e.g. "PC Center of Excellence". */
      staffLevels: z.array(z.string()).default([]),
      /** Regexes on the normalised identifier that mark dummy/placeholder accounts. */
      dummyIdentifierPatterns: z.array(z.string()).default([]),
    }),
  }),

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
    /** list_people: max people for filtering by a per-person signal (query_metrics batches instead). */
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
