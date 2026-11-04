import { describe, expect, it } from "vitest";
import { classify, familyNotes, matchesFilters, normaliseIdentifier, parseBranch } from "@/domain/people";
import { account, glaStaging } from "./helpers";

const t = glaStaging();
const status = (over: Parameters<typeof account>[0]) => {
  const v = classify(account(over), t);
  return v.reason ? `${v.status}:${v.reason}` : v.status;
};

describe("identity status (sampled staging patterns)", () => {
  it("counts canonical and alphanumeric 12-char Conso IDs as dealers", () => {
    expect(status({ userId: 1, profile: { dealer_conso_id: "077700099283" } })).toBe("person");
    expect(status({ userId: 2, username: "x", profile: { dealer_conso_id: "500000j99901" } })).toBe("person");
    expect(status({ userId: 3, username: "x", profile: { dealer_conso_id: "0077000QX901" } })).toBe("person");
    // test account with a legitimate structure still counts (per business rule)
    expect(status({ userId: 4, profile: { dealer_conso_id: "000700099515" } })).toBe("person");
  });

  it("repairs a dropped leading zero and merges duplicate accounts on the identifier", () => {
    expect(normaliseIdentifier("99900077574", t)).toEqual({ value: "099900077574", repaired: true });
    const a = classify(
      account({ userId: 1, username: "a", profile: { dealer_conso_id: "099900077574" } }),
      t,
    );
    const b = classify(account({ userId: 2, username: "b", profile: { dealer_conso_id: "99900077574" } }), t);
    expect(a.key).toBe(b.key);
    expect(b.identifierNormalised).toBe(true);
  });

  it("falls back to a Conso-shaped username when the profile value is malformed", () => {
    expect(
      status({ userId: 1, username: "007700903123", profile: { dealer_conso_id: "fb 007700901" } }),
    ).toBe("person");
  });

  it("tags old/malformed formats and missing IDs as legacy", () => {
    // incl. the 10-char "branch + 6 digits" format: old format → legacy (business decision)
    for (const id of ["fb 007700901", "nl_0999_0007", "glp_00099", "077700000", "0777001474", "13182", ""]) {
      expect(status({ userId: 1, username: "legacy.user", profile: { dealer_conso_id: id } })).toBe("legacy");
    }
  });

  it("excludes staff by Dealer Level, dummies by pattern, the UAT pool and non-learner roles", () => {
    expect(
      status({ userId: 1, profile: { dealer_conso_id: "4321", level: "PC Center of Excellence" } }),
    ).toBe("excluded:staff");
    expect(
      status({ userId: 1, profile: { dealer_conso_id: "099900tn0999", level: "pc center of excellence" } }),
    ).toBe("excluded:staff");
    for (const id of [
      "111111111111",
      "000000000000",
      "123123123123",
      "121212121212",
      "111111111112",
      "0",
      "000",
      "00000",
    ]) {
      expect(status({ userId: 1, username: "x.y", profile: { dealer_conso_id: id } })).toBe("excluded:dummy");
    }
    expect(
      status({ userId: 1, username: "111111111125", profile: { dealer_conso_id: "111111111125" } }),
    ).toBe("excluded:test");
    expect(status({ userId: 1, courseRoles: ["editingteacher"] })).toBe("excluded:role");
    expect(status({ userId: 1, courseRoles: ["student", "redemptionmanager"] })).toBe("excluded:role");
  });

  it("does not flag canonical ids with a repeated 4-digit block as dummy", () => {
    expect(status({ userId: 1, profile: { dealer_conso_id: "000100010001" } })).toBe("person");
  });

  it("uses profile values verbatim and N/A for empty", () => {
    const v = classify(
      account({
        userId: 1,
        profile: { Region_Dropdown: "Visayas 2", level: "", branch_code: "CUBAO (0101)" },
      }),
      t,
    );
    expect(v.region).toBe("Visayas 2");
    expect(v.level).toBe("N/A");
    expect(v.branch).toEqual({ label: "CUBAO (0101)", name: "CUBAO", code: "0101" });
  });
});

describe("branch values", () => {
  it("keeps the stored label and exposes name + code", () => {
    expect(parseBranch("DAVAO (0575C)", "name_with_code", "N/A").code).toBe("0575c");
    expect(parseBranch("0032", "name_with_code", "N/A")).toEqual({ label: "0032", name: null, code: "0032" });
    expect(parseBranch("777", "name_with_code", "N/A")).toEqual({ label: "777", name: null, code: null });
    expect(parseBranch(" ", "name_with_code", "N/A")).toEqual({ label: "N/A", name: null, code: null });
  });
});

describe("filters and similar values", () => {
  const v = classify(
    account({
      userId: 1,
      profile: { Region_Dropdown: "Visayas 1", level: "Great Life Builder", branch_code: "CUBAO (0101)" },
    }),
    t,
  );
  it("match exactly (case-insensitive); branch by label, name or code", () => {
    expect(matchesFilters(v, { region: ["visayas 1"] }, "N/A")).toBe(true);
    expect(matchesFilters(v, { region: ["Visayas"] }, "N/A")).toBe(false); // separate value, not a prefix
    expect(matchesFilters(v, { branch: ["0101"] }, "N/A")).toBe(true);
    expect(matchesFilters(v, { branch: ["cubao"] }, "N/A")).toBe(true);
  });
  it("explains look-alike values without merging them", () => {
    const notes = familyNotes("Region", ["Visayas", "Visayas 1", "Visayas 2", "Mega Manila"]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/"Visayas", "Visayas 1", "Visayas 2" are separate values/);
    expect(
      familyNotes("Region", ["Visayas", "Visayas 1", "Mindanao", "Mindanao 3"], ["Mindanao"]),
    ).toHaveLength(1);
  });
});
