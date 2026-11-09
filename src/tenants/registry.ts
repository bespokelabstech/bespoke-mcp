import { AppError } from "@/core/errors";
import { gla } from "./gla";
import { mergeOverlay } from "./merge";
import type { EnvironmentName, TenantConfig, TenantConfigInput, TenantOverlay } from "./schema";
import { tenantConfigSchema } from "./schema";

export interface TenantDefinition {
  base: TenantConfigInput;
  overlays: Record<EnvironmentName, TenantOverlay>;
}

/** All tenants this codebase knows. Adding a tenant = adding a folder + one line here. */
const TENANTS: Record<string, TenantDefinition> = { gla };

export function knownTenants(): string[] {
  return Object.keys(TENANTS);
}

/** Resolve base + environment overlay and validate the result. Throws on invalid config. */
export function loadTenant(tenantId: string, env: EnvironmentName): TenantConfig {
  const def = TENANTS[tenantId];
  if (!def) {
    throw new AppError("not_configured", `Unknown tenant "${tenantId}".`, { known: knownTenants() });
  }
  const merged = mergeOverlay(def.base, def.overlays[env]);
  const parsed = tenantConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new AppError("not_configured", `Tenant "${tenantId}" config is invalid.`, {
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  const def0 = parsed.data.defaults.savedFilter;
  if (def0 !== null && !parsed.data.savedFilters[def0]) {
    throw new AppError(
      "not_configured",
      `Tenant "${tenantId}" default saved filter "${def0}" is not defined.`,
    );
  }
  if (!parsed.data.environments[env]) {
    throw new AppError("not_configured", `Tenant "${tenantId}" has no "${env}" environment.`);
  }
  return parsed.data;
}
