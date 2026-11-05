import type { DimensionId, TenantConfig } from "@/tenants/schema";

/**
 * Turning LMS accounts into business people (e.g. Dealers): identity status, identifier and
 * business attributes. Every rule comes from tenant config; nothing client-specific here.
 *
 * Attribute values are taken VERBATIM from the profile (the LMS profile is the source of
 * truth). Empty values become the tenant's emptyValueLabel ("N/A").
 */

/** Exactly one per account. See docs/METRICS.md#population. */
export type Status = "person" | "legacy" | "excluded";
export type ExclusionReason = "role" | "test" | "staff" | "dummy";
export const STATUSES: readonly Status[] = ["person", "legacy", "excluded"];

export interface BranchValue {
  /** Stored value as shown in the LMS, e.g. "QUEZON AVE (0032)". */
  label: string;
  name: string | null;
  code: string | null;
}

export interface PersonView {
  userId: number;
  /** Counting key: the normalised identifier for `person` (merges duplicate accounts), else the account. */
  key: string;
  status: Status;
  reason: ExclusionReason | null;
  /** Normalised identifier when structurally valid, else the raw stored value (or null). */
  identifier: string | null;
  /** True when the identifier was repaired (e.g. a dropped leading zero). */
  identifierNormalised: boolean;
  name: string;
  region: string;
  level: string;
  branch: BranchValue;
}

export interface AccountInput {
  userId: number;
  username: string;
  firstName: string;
  lastName: string;
  profile: Record<string, string>;
  /** Course roles; omit for direct lookups (role rules then do not apply). */
  courseRoles?: string[];
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

/** Lower-case, trim and repair a dropped leading zero (11 → 12 digits) when configured. */
export function normaliseIdentifier(raw: string, tenant: TenantConfig): { value: string; repaired: boolean } {
  const v = raw.trim().toLowerCase();
  const { padNumericFrom, padNumericTo } = tenant.identity;
  if (padNumericFrom && padNumericTo && v.length === padNumericFrom && /^\d+$/.test(v)) {
    return { value: v.padStart(padNumericTo, "0"), repaired: true };
  }
  return { value: v, repaired: false };
}

interface Compiled {
  valid: RegExp;
  dummies: RegExp[];
  staff: Set<string>;
}
const compiled = new WeakMap<TenantConfig, Compiled>();
function rules(t: TenantConfig): Compiled {
  let c = compiled.get(t);
  if (!c) {
    c = {
      valid: new RegExp(t.identity.validPattern),
      dummies: t.eligibility.exclude.dummyIdentifierPatterns.map((p) => new RegExp(p)),
      staff: new Set(t.eligibility.exclude.staffLevels.map((l) => l.trim().toLowerCase())),
    };
    compiled.set(t, c);
  }
  return c;
}

/**
 * Classify one account. Order matters:
 *   1. role      — not a learner role in this course, or an excluded role
 *   2. test      — explicitly excluded username / username range
 *   3. staff     — staff Dealer Level
 *   4. dummy     — identifier matches a placeholder pattern
 *   5. person    — profile identifier, else username, is structurally valid after normalisation
 *   6. legacy    — everything else (no identifier, or an old/malformed format)
 */
export function classify(a: AccountInput, tenant: TenantConfig): PersonView {
  const r = rules(tenant);
  const ex = tenant.eligibility.exclude;
  const d = tenant.dimensions;
  const empty = tenant.emptyValueLabel;
  const val = (shortname: string) => a.profile[shortname]?.trim() || empty;
  const base = {
    userId: a.userId,
    name: `${a.firstName} ${a.lastName}`.trim(),
    region: val(d.region.profileField),
    level: val(d.level.profileField),
    branch: parseBranch(a.profile[d.branch.profileField] ?? "", d.branch.format, empty),
  };

  // Candidate identifiers: profile field first, then the username.
  const emptyValues = new Set(tenant.identity.emptyValues.map((x) => x.toLowerCase()));
  const candidates = [a.profile[tenant.identity.profileField] ?? "", a.username]
    .filter((v) => v.trim() !== "" && !emptyValues.has(v.trim().toLowerCase()))
    .map((v) => normaliseIdentifier(v, tenant));
  const valid = candidates.find((c) => r.valid.test(c.value));
  const shown = valid ?? candidates[0] ?? null;
  const account = `u:${a.userId}`;
  const excluded = (reason: ExclusionReason): PersonView => ({
    ...base,
    key: account,
    status: "excluded",
    reason,
    identifier: shown?.value ?? null,
    identifierNormalised: shown?.repaired ?? false,
  });

  if (a.courseRoles) {
    if (a.courseRoles.some((role) => ex.courseRoles.includes(role))) return excluded("role");
    if (!a.courseRoles.some((role) => tenant.eligibility.requiredCourseRoles.includes(role))) {
      return excluded("role");
    }
  }
  const username = a.username.trim().toLowerCase();
  if (ex.usernames.some((u) => u.toLowerCase() === username)) return excluded("test");
  if (ex.usernameRanges.some(([lo, hi]) => inRange(username, lo, hi))) return excluded("test");
  if (r.staff.has(base.level.toLowerCase())) return excluded("staff");
  if (candidates.some((c) => r.dummies.some((re) => re.test(c.value)))) return excluded("dummy");
  if (valid) {
    return {
      ...base,
      key: `id:${valid.value}`,
      status: "person",
      reason: null,
      identifier: valid.value,
      identifierNormalised: valid.repaired,
    };
  }
  return {
    ...base,
    key: account,
    status: "legacy",
    reason: null,
    identifier: shown?.value ?? null,
    identifierNormalised: false,
  };
}

function inRange(value: string, lo: string, hi: string): boolean {
  const numeric = /^\d+$/;
  if (
    numeric.test(value) &&
    numeric.test(lo) &&
    numeric.test(hi) &&
    value.length === lo.length &&
    lo.length === hi.length
  ) {
    const v = BigInt(value);
    return v >= BigInt(lo) && v <= BigInt(hi);
  }
  return value >= lo.toLowerCase() && value <= hi.toLowerCase();
}

// ---------------------------------------------------------------- filters & grouping

export type Filters = Partial<Record<DimensionId, string[]>>;

const norm = (s: string) => s.trim().toLowerCase();

/** Case-insensitive exact match. Branch filters match the label, the name or the code. */
export function matchesFilters(p: PersonView, filters: Filters, emptyLabel: string): boolean {
  for (const [dim, wanted] of Object.entries(filters) as Array<[DimensionId, string[] | undefined]>) {
    if (!wanted || wanted.length === 0) continue;
    const want = new Set(wanted.map(norm));
    const candidates =
      dim === "branch"
        ? [p.branch.label, p.branch.name ?? emptyLabel, p.branch.code ?? emptyLabel]
        : [dim === "region" ? p.region : p.level];
    if (!candidates.some((c) => want.has(norm(c)))) return false;
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
