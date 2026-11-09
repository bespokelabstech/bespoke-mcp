import type { Condition, DimensionId, SavedFilterField, TenantConfig } from "@/tenants/schema";

/**
 * Turning LMS accounts into business accounts (e.g. Dealers): identity, business attributes and
 * the saved-filter verdict (e.g. "Valid dealer"). Every rule comes from tenant config; nothing
 * client-specific here. Each account counts on its own — accounts are never merged and
 * identifiers are never repaired.
 *
 * Attribute values are taken VERBATIM from the profile (the LMS profile is the source of
 * truth). Empty values become the tenant's emptyValueLabel ("N/A").
 */

export interface BranchValue {
  /** Stored value as shown in the LMS, e.g. "QUEZON AVE (0032)". */
  label: string;
  name: string | null;
  code: string | null;
}

export interface PersonView {
  userId: number;
  username: string;
  /** Identifier profile value as stored (trimmed); null when empty or a placeholder. */
  identifier: string | null;
  name: string;
  region: string;
  level: string;
  branch: BranchValue;
  /** Passes the tenant's default saved filter (true when none is configured). */
  valid: boolean;
  /** Labels of the saved-filter conditions this account fails, in config order. */
  failed: string[];
}

export interface AccountInput {
  userId: number;
  username: string;
  firstName: string;
  lastName: string;
  profile: Record<string, string>;
}

const LABEL_RE = /^(.*) \(([0-9A-Za-z]+)\)$/; // mirrors local_profileform catalog::LABEL_RE
const BARE_CODE_RE = /^[0-9]{4}[A-Za-z]?$/;

export function parseBranch(raw: string, format: "verbatim" | "name_with_code", empty: string): BranchValue {
  const value = raw.trim();
  if (value === "") return { label: empty, name: null, code: null };
  if (format === "verbatim") return { label: value, name: value, code: null };
  const m = LABEL_RE.exec(value);
  if (m) return { label: value, name: m[1]!.trim() || null, code: m[2]!.toLowerCase() };
  if (BARE_CODE_RE.test(value)) return { label: value, name: null, code: value.toLowerCase() };
  return { label: value, name: null, code: null };
}

interface CompiledCondition {
  c: Condition;
  test: (v: string) => boolean;
}
interface Compiled {
  placeholders: Set<string>;
  filter: { require: CompiledCondition[]; reject: CompiledCondition[] } | null;
}
const compiled = new WeakMap<TenantConfig, Compiled>();

const norm = (s: string) => s.trim().toLowerCase();

function compileCondition(c: Condition): CompiledCondition {
  const values = (Array.isArray(c.value) ? c.value : [c.value]).map(norm);
  switch (c.op) {
    case "in":
      return { c, test: (v) => values.includes(v) };
    case "not_in":
      return { c, test: (v) => !values.includes(v) };
    case "equals":
      return { c, test: (v) => v === values[0] };
    case "matches": {
      const re = new RegExp(c.value as string);
      return { c, test: (v) => re.test(v) };
    }
  }
}

function rules(t: TenantConfig): Compiled {
  let r = compiled.get(t);
  if (!r) {
    const def = t.defaults.savedFilter ? t.savedFilters[t.defaults.savedFilter] : undefined;
    r = {
      placeholders: new Set(t.placeholderValues.map(norm)),
      filter: def
        ? { require: def.require.map(compileCondition), reject: def.reject.map(compileCondition) }
        : null,
    };
    compiled.set(t, r);
  }
  return r;
}

/** Saved-filter field values: trimmed and lower-cased; an empty identifier is "". */
function fieldValues(a: AccountInput, identifier: string | null): Record<SavedFilterField, string> {
  return {
    username: norm(a.username),
    conso_id: norm(identifier ?? ""),
    name: norm(`${a.firstName} ${a.lastName}`),
  };
}

/** Build the business view of one account and evaluate the default saved filter. */
export function classify(a: AccountInput, tenant: TenantConfig): PersonView {
  const r = rules(tenant);
  const d = tenant.dimensions;
  const empty = tenant.emptyValueLabel;
  // Placeholder text typed into a field ("n/a", "none", …) counts as empty everywhere.
  const raw = (shortname: string) => {
    const v = a.profile[shortname]?.trim() ?? "";
    return r.placeholders.has(v.toLowerCase()) ? "" : v;
  };
  const identifier = raw(tenant.identity.profileField) || null;
  const failed: string[] = [];
  if (r.filter) {
    const values = fieldValues(a, identifier);
    for (const x of r.filter.require) if (!x.test(values[x.c.field])) failed.push(x.c.label);
    for (const x of r.filter.reject) if (x.test(values[x.c.field])) failed.push(x.c.label);
  }
  return {
    userId: a.userId,
    username: a.username,
    identifier,
    name: `${a.firstName} ${a.lastName}`.trim(),
    region: raw(d.region.profileField) || empty,
    level: raw(d.level.profileField) || empty,
    branch: parseBranch(raw(d.branch.profileField), d.branch.format, empty),
    valid: failed.length === 0,
    failed,
  };
}

/** True if the account holds a learner role and no non-learner role in this course. */
export function isLearner(courseRoles: string[], tenant: TenantConfig): boolean {
  const { learnerRoles, nonLearnerRoles } = tenant.accounts;
  return (
    courseRoles.some((role) => learnerRoles.includes(role)) &&
    !courseRoles.some((role) => nonLearnerRoles.includes(role))
  );
}

// ---------------------------------------------------------------- filters & grouping

export type DimensionValues = Partial<Record<DimensionId, string[]>>;

/** Include lists (keep only these values) and exclude lists (drop these values). */
export interface Filters {
  include: DimensionValues;
  exclude: DimensionValues;
}

export const NO_FILTERS: Filters = { include: {}, exclude: {} };

function candidates(p: PersonView, dim: DimensionId, emptyLabel: string): string[] {
  return dim === "branch"
    ? [p.branch.label, p.branch.name ?? emptyLabel, p.branch.code ?? emptyLabel]
    : [dim === "region" ? p.region : p.level];
}

/**
 * Case-insensitive exact match. Branch values match the label, the name or the code.
 * An account is kept when it matches every non-empty include list and no exclude list.
 */
export function matchesFilters(p: PersonView, filters: Filters, emptyLabel: string): boolean {
  for (const [dim, wanted] of Object.entries(filters.include) as Array<[DimensionId, string[] | undefined]>) {
    if (!wanted || wanted.length === 0) continue;
    const want = new Set(wanted.map(norm));
    if (!candidates(p, dim, emptyLabel).some((c) => want.has(norm(c)))) return false;
  }
  for (const [dim, unwanted] of Object.entries(filters.exclude) as Array<
    [DimensionId, string[] | undefined]
  >) {
    if (!unwanted || unwanted.length === 0) continue;
    const drop = new Set(unwanted.map(norm));
    if (candidates(p, dim, emptyLabel).some((c) => drop.has(norm(c)))) return false;
  }
  return true;
}

export function dimensionValue(p: PersonView, dim: DimensionId): string {
  if (dim === "branch") return p.branch.label;
  return dim === "region" ? p.region : p.level;
}

/** "Visayas 2" -> "visayas". Values sharing a family are distinct values, not aliases. */
export function familyOf(value: string): string {
  return norm(value).replace(/\s+\d+$/, "");
}

/**
 * Clarification notes for values that look alike but are stored separately, e.g. "Visayas"
 * next to "Visayas 1/2/3". The system's values are never merged — this only tells the reader.
 */
export function familyNotes(label: string, values: string[], focus?: string[]): string[] {
  const byFamily = new Map<string, Set<string>>();
  for (const v of values) {
    const f = familyOf(v);
    byFamily.set(f, (byFamily.get(f) ?? new Set()).add(v));
  }
  const focusFamilies = focus?.length ? new Set(focus.map(familyOf)) : null;
  const notes: string[] = [];
  for (const [f, set] of byFamily) {
    if (set.size < 2 || (focusFamilies && !focusFamilies.has(f))) continue;
    const list = [...set].sort();
    notes.push(
      `${label} values ${list.map((v) => `"${v}"`).join(", ")} are separate values in the system. ` +
        "They are reported as stored and not merged; ask which one is meant if unclear.",
    );
  }
  return notes;
}
