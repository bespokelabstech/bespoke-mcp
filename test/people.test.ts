import { describe, expect, it } from "vitest";
import { classify, familyNotes, isLearner, matchesFilters, parseBranch } from "@/domain/people";
import { tenantConfigSchema } from "@/tenants/schema";
import { account, glaStaging } from "./helpers";

const t = glaStaging();
const view = (over: Parameters<typeof account>[0]) => classify(account(over), t);

describe("valid_dealers saved filter (provisional GLA rules)", () => {
  it("passes canonical, alphanumeric and legacy-format accounts — no format rule", () => {
    for (const id of [
      "077700099283",
      "500000j99901",
      "0077000QX901",
      "fb 007700901",
      "nl_0999_0007",
      "077700000",
      "",
    ]) {
      expect(view({ userId: 1, username: "legacy.user", profile: { dealer_conso_id: id } }).valid).toBe(true);
    }
    // test account with a legitimate structure still counts (per business rule)
    expect(view({ userId: 4, profile: { dealer_conso_id: "000700099515" } }).valid).toBe(true);
  });

  it("rejects dummy Conso IDs and dummy usernames, naming the failed rule", () => {
    for (const id of [
      "111111111111",
      "000000000000",
      "123123123123",
      "121212121212",
      "111111111112",
      "0",
      "000",
    ]) {
      const v = view({ userId: 1, username: "x.y", profile: { dealer_conso_id: id } });
      expect(v.valid).toBe(false);
      expect(v.failed).toEqual(["Dummy Conso ID"]);
    }
    // staging UAT pool: caught by the 1111111111xx pattern on the username
    expect(view({ userId: 1, username: "111111111125", profile: {} }).failed).toEqual(["Dummy username"]);
  });

  it("does not flag canonical ids with a repeated 4-digit block as dummy", () => {
    expect(view({ userId: 1, profile: { dealer_conso_id: "000100010001" } }).valid).toBe(true);
  });

  it("keeps the Conso ID as stored: no leading-zero repair, placeholders are empty", () => {
    expect(view({ userId: 1, profile: { dealer_conso_id: " 99900077574 " } }).identifier).toBe("99900077574");
    expect(view({ userId: 1, profile: { dealer_conso_id: "N/A" } }).identifier).toBeNull();
  });

  it("COE is not a saved-filter rule (it is a level default)", () => {
    expect(
      view({ userId: 1, profile: { dealer_conso_id: "4321", level: "PC Center of Excellence" } }).valid,
    ).toBe(true);
  });
});

describe("base scope (learner accounts)", () => {
  it("needs the student role and no trainer or admin role in the course", () => {
    expect(isLearner(["student"], t)).toBe(true);
    expect(isLearner(["editingteacher"], t)).toBe(false);
    expect(isLearner(["student", "redemptionmanager"], t)).toBe(false);
    expect(isLearner(["student", "teacher"], t)).toBe(false);
  });
});

describe("tenant config", () => {
  it("rejects saved-filter conditions on fields that have their own filter, and bad values", () => {
    const base = { ...t, savedFilters: {} } as Record<string, unknown>;
    const bad = (cond: Record<string, unknown>) =>
      tenantConfigSchema.safeParse({
        ...base,
        savedFilters: { f: { label: "F", reject: [{ label: "x", ...cond }] } },
      }).success;
    expect(bad({ field: "level", op: "in", value: ["PC Center of Excellence"] })).toBe(false);
    expect(bad({ field: "username", op: "in", value: "one" })).toBe(false);
    expect(bad({ field: "username", op: "matches", value: "(" })).toBe(false);
    expect(bad({ field: "username", op: "in", value: ["admin"] })).toBe(true);
  });
});

describe("profile values", () => {
  it('treats placeholder text in profile fields as empty ("N/A")', () => {
    const v = view({ userId: 1, profile: { Region_Dropdown: "n/a", level: "None", branch_code: "-" } });
    expect(v.region).toBe("N/A");
    expect(v.level).toBe("N/A");
    expect(v.branch.label).toBe("N/A");
  });

  it("uses profile values verbatim and N/A for empty", () => {
    const v = view({
      userId: 1,
      profile: { Region_Dropdown: "Visayas 2", level: "", branch_code: "CUBAO (0101)" },
    });
    expect(v.region).toBe("Visayas 2");
    expect(v.level).toBe("N/A");
    expect(v.branch).toEqual({ label: "CUBAO (0101)", name: "CUBAO", code: "0101" });
  });

  it("branch keeps the stored label and exposes name + code", () => {
    expect(parseBranch("DAVAO (0575C)", "name_with_code", "N/A").code).toBe("0575c");
    expect(parseBranch("0032", "name_with_code", "N/A")).toEqual({ label: "0032", name: null, code: "0032" });
    expect(parseBranch("777", "name_with_code", "N/A")).toEqual({ label: "777", name: null, code: null });
    expect(parseBranch(" ", "name_with_code", "N/A")).toEqual({ label: "N/A", name: null, code: null });
  });
});

describe("filters and similar values", () => {
  const v = view({
    userId: 1,
    profile: { Region_Dropdown: "Visayas 1", level: "Great Life Builder", branch_code: "CUBAO (0101)" },
  });
  const inc = (include: Record<string, string[]>) => matchesFilters(v, { include, exclude: {} }, "N/A");
  const exc = (exclude: Record<string, string[]>) => matchesFilters(v, { include: {}, exclude }, "N/A");
  it("include lists match exactly (case-insensitive); branch by label, name or code", () => {
    expect(inc({ region: ["visayas 1"] })).toBe(true);
    expect(inc({ region: ["Visayas"] })).toBe(false); // separate value, not a prefix
    expect(inc({ branch: ["0101"] })).toBe(true);
    expect(inc({ branch: ["cubao"] })).toBe(true);
  });
  it("exclude lists drop matching values", () => {
    expect(exc({ level: ["great life builder"] })).toBe(false);
    expect(exc({ level: ["PC Center of Excellence"] })).toBe(true);
    expect(exc({ branch: ["0101"] })).toBe(false);
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
