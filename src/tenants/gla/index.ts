import type { TenantDefinition } from "../registry";
import { glaBase } from "./base";
import { glaProduction } from "./production";
import { glaStaging } from "./staging";

export const gla: TenantDefinition = {
  base: glaBase,
  overlays: { staging: glaStaging, production: glaProduction },
};
