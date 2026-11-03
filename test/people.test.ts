import { describe, expect, it } from "vitest";
import {
  matchesFilters,
  parseBranch,
  participantIneligibility,
  personIneligibility,
  toPersonView,
} from "@/domain/people";
import { glaStaging, participant } from "./helpers";

const t = glaStaging();

describe("branch values", () => {
  it("keeps the stored label and exposes name + code", () => {
    expect(parseBranch("QUEZON AVE (0032)", "name_with_code", "N/A")).toEqual({
      label: "QUEZON AVE (0032)",
      name: "QUEZON AVE",
      code: "0032",
    });
    expect(parseBranch("DAVAO (0575C)", "name_with_code", "N/A").code).toBe("0575c");
  });
  it("handles legacy bare codes, junk and empty values", () => {
    expect(parseBranch("0032", "name_with_code", "N/A")).toEqual({ label: "0032", name: null, code: "0032" });
    expect(parseBranch("11111111111", "name_with_code", "N/A")).toEqual({
      label: "11111111111",
      name: null,
      code: null,
    });
    expect(parseBranch("  ", "name_with_code", "N/A")).toEqual({ label: "N/A", name: null, code: null });
  });
});

describe("person view", () => {
  it("uses profile values verbatim and N/A for empty", () => {
    const v = toPersonView(
      participant({
        userId: 1,
        profile: { Region_Dropdown: "Metro Manila", level: "", branch_code: "CUBAO (0101)" },
      }),
      t,
    );
    expect(v.region).toBe("Metro Manila");
    expect(v.level).toBe("N/A");
    expect(v.branch).toEqual({ label: "CUBAO (0101)", name: "CUBAO", code: "0101" });
  });
  it("identifier prefers dealer_conso_id, falls back to a Conso-shaped username", () => {
    expect(
      toPersonView(participant({ userId: 1, profile: { dealer_conso_id: "ABCDEF123456" } }), t).identifier,
    ).toBe("abcdef123456");
    expect(toPersonView(participant({ userId: 2, username: "abcdef654321" }), t).identifier).toBe(
      "abcdef654321",
    );
    expect(toPersonView(participant({ userId: 3, username: "legacy.user" }), t).identifier).toBeNull();
  });
});

describe("dealer rule", () => {
  it("counts students with a Conso ID", () => {
    expect(participantIneligibility(participant({ userId: 1 }), t)).toBeNull();
  });
  it("drops non-students, excluded roles, staff without an identifier and the UAT pool", () => {
    expect(participantIneligibility(participant({ userId: 1, courseRoles: ["editingteacher"] }), t)).toBe(
      "missing_role",
    );
    expect(
      participantIneligibility(participant({ userId: 1, courseRoles: ["student", "redemptionmanager"] }), t),
    ).toBe("excluded_role");
    expect(participantIneligibility(participant({ userId: 1, username: "staff.jdoe" }), t)).toBe(
      "missing_identifier",
    );
    expect(
      personIneligibility({ username: "111111111125", profile: { dealer_conso_id: "111111111125" } }, t),
    ).toBe("excluded_username");
    expect(
      personIneligibility({ username: "111111111170", profile: { dealer_conso_id: "111111111170" } }, t),
    ).toBeNull();
  });
});

describe("filters", () => {
  const v = toPersonView(
    participant({
      userId: 1,
      profile: { Region_Dropdown: "Metro Manila", level: "Great Life Builder", branch_code: "CUBAO (0101)" },
    }),
    t,
  );
  it("match case-insensitively; branch by label, name or code", () => {
    expect(matchesFilters(v, { region: ["metro manila"] }, "N/A")).toBe(true);
    expect(matchesFilters(v, { branch: ["0101"] }, "N/A")).toBe(true);
    expect(matchesFilters(v, { branch: ["cubao"] }, "N/A")).toBe(true);
    expect(matchesFilters(v, { branch: ["CUBAO (0101)"], level: ["Great Life Builder"] }, "N/A")).toBe(true);
    expect(matchesFilters(v, { level: ["Great Life Manager"] }, "N/A")).toBe(false);
  });
  it("N/A selects empty values", () => {
    const empty = toPersonView(participant({ userId: 2 }), t);
    expect(matchesFilters(empty, { region: ["N/A"] }, "N/A")).toBe(true);
  });
});
