import type { Participant, PersonRecord } from "@/ports/learning";
import type { DimensionId, TenantConfig } from "@/tenants/schema";

/**
 * Turning LMS users into business people (e.g. Dealers): eligibility rule, identifier
 * and business attributes. All rules come from tenant config; nothing PC-specific here.
 *
 * Attribute values are taken VERBATIM from the profile (the profile is the source of
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
  identifier: string | null;
  name: string;
  region: string;
  level: string;
  branch: BranchValue;
}

export type Ineligibility = "missing_role" | "missing_identifier" | "excluded_username" | "excluded_role";

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

export function identifierOf(
  user: { username: string; profile: Record<string, string> },
  tenant: TenantConfig,
): string | null {
  const fromProfile = user.profile[tenant.identity.profileField]?.trim();
  if (fromProfile) return fromProfile.toLowerCase();
  const u = user.username.trim().toLowerCase();
  return new RegExp(tenant.identity.usernamePattern).test(u) ? u : null;
}

export function toPersonView(
  user: {
    userId: number;
    username: string;
    firstName: string;
    lastName: string;
    profile: Record<string, string>;
  },
  tenant: TenantConfig,
): PersonView {
  const d = tenant.dimensions;
  const empty = tenant.emptyValueLabel;
  const val = (shortname: string) => user.profile[shortname]?.trim() || empty;
  return {
    userId: user.userId,
    identifier: identifierOf(user, tenant),
    name: `${user.firstName} ${user.lastName}`.trim(),
    region: val(d.region.profileField),
    level: val(d.level.profileField),
    branch: parseBranch(user.profile[d.branch.profileField] ?? "", d.branch.format, empty),
  };
}

/** Identity + exclusion checks that do not depend on a course (used for direct lookups). */
export function personIneligibility(
  user: { username: string; profile: Record<string, string> },
  tenant: TenantConfig,
): Ineligibility | null {
  const ex = tenant.eligibility.exclude;
  const username = user.username.trim().toLowerCase();
  if (ex.usernames.some((u) => u.toLowerCase() === username)) return "excluded_username";
  if (ex.usernameRanges.some(([lo, hi]) => inRange(username, lo, hi))) return "excluded_username";
  if (tenant.eligibility.requireIdentity && identifierOf(user, tenant) === null) return "missing_identifier";
  return null;
}

/** Full rule for a course participant: course role + identity + exclusions. */
export function participantIneligibility(p: Participant, tenant: TenantConfig): Ineligibility | null {
  const roles = p.courseRoles;
  if (roles.some((r) => tenant.eligibility.exclude.courseRoles.includes(r))) return "excluded_role";
  if (!roles.some((r) => tenant.eligibility.requiredCourseRoles.includes(r))) return "missing_role";
  return personIneligibility(p, tenant);
}

export function isPersonRecordEligible(p: PersonRecord, tenant: TenantConfig): Ineligibility | null {
  return personIneligibility(p, tenant);
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

/** Case-insensitive match. Branch filters match the label, the name or the code. */
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
