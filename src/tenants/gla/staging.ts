import type { TenantOverlay } from "../schema";

/**
 * Staging overlay. Staging is rebuilt from prod and also holds the UAT tester pool
 * (111111111119–169); the dummy-ID rule in valid_dealers already rejects those usernames.
 */
export const glaStaging: TenantOverlay = {};
