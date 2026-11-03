import type { TenantOverlay } from "../schema";

/** Staging overlay: staging is rebuilt from prod and additionally holds the UAT tester pool. */
export const glaStaging: TenantOverlay = {
  eligibility: {
    exclude: {
      // gla-bihasa-app/docs/uat/scripts/README.md: shared learner 111111111119 + pool 120..169
      usernameRanges: [["111111111119", "111111111169"]],
    },
  },
};
