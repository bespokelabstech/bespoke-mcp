import { describe, expect, it } from "vitest";
import { classify, familyNotes, isLearner, matchesFilters, parseBranch } from "@/domain/people";
import { tenantConfigSchema } from "@/tenants/schema";
import { account, glaStaging } from "./helpers";

const t = glaStaging();
/** A clean, valid dealer unless the test overrides something. */
const view = (over: Parameters<typeof account>[0]) =>
  classify(
    account({
      emailDomain: "@example.com",
      suspended: false,
      ...over,
      profile: { level: "Great Life Builder", ...over.profile },
    }),
    t,
  );
const hiddenBy = (over: Parameters<typeof account>[0]) => view(over).failed;

describe("valid_dealers saved filter (BES-465 rules, provisional)", () => {
  it("keeps real dealers, legacy formats and duplicates — there is no format rule", () => {
    for (const username of [
      "077700099283",
      "500000j99901",
      "fb.user",
      "nl_0999_0007",
      "000700099515",
      "000100010001",
    ]) {
      expect(hiddenBy({ userId: 1, username })).toEqual([]);
    }
  });

  it("1. internal email domains (only the domain is read)", () => {
    for (const d of ["@bihasa.ph", "@bespokelabs.tech", "@training.net", "@BIHASA.PH"]) {
      expect(hiddenBy({ userId: 1, emailDomain: d })).toEqual(["Internal email domain"]);
    }
    expect(hiddenBy({ userId: 1, emailDomain: "@notbihasa.ph.example" })).toEqual([]);
    expect(hiddenBy({ userId: 1, emailDomain: "@gmail.com" })).toEqual([]);
  });

  it("2. training, test or admin usernames", () => {
    for (const u of ["gla.train01", "glass.train.2", "aimon.test", "testuser", "siteadmin"]) {
      expect(hiddenBy({ userId: 1, username: u })).toContain("Test, training or admin username");
    }
    expect(hiddenBy({ userId: 1, username: "gla.trainee.not" })).toContain(
      "Test, training or admin username",
    );
    expect(hiddenBy({ userId: 1, username: "glatrain" })).toEqual([]);
  });

  it("3. whole-word test or dummy names, and Admin User", () => {
    for (const [f, l] of [
      ["Dummy", "Account"],
      ["Juan", "TEST"],
      ["Sample", "Dealer"],
      ["Demo", "One"],
      ["Student", "X"],
      ["Try", "Me"],
      ["Admin", "User"],
    ]) {
      expect(hiddenBy({ userId: 1, firstName: f, lastName: l })).toEqual(["Test or dummy name"]);
    }
    // whole words only
    for (const [f, l] of [
      ["Testa", "Cruz"],
      ["Trystan", "Lim"],
      ["Admin", "Users"],
      ["Demolition", "Santos"],
    ]) {
      expect(hiddenBy({ userId: 1, firstName: f, lastName: l })).toEqual([]);
    }
  });

  it("4. dummy Conso IDs in the username", () => {
    for (const u of [
      "999100012345",
      "000000000",
      "111111111111",
      "111111111125",
      "1111111",
      "123456789012",
    ]) {
      expect(hiddenBy({ userId: 1, username: u })).toEqual(["Dummy Conso ID"]);
    }
    for (const u of ["077700099283", "000100001234", "100000000000", "123123123123"]) {
      expect(hiddenBy({ userId: 1, username: u })).toEqual([]);
    }
  });

  it("5. placeholder names: blank, PC SFLMS Live, or starting with a legacy username", () => {
    expect(hiddenBy({ userId: 1, firstName: "", lastName: " " })).toEqual(["Placeholder name"]);
    expect(hiddenBy({ userId: 1, firstName: "PC SFLMS Live", lastName: "3" })).toEqual(["Placeholder name"]);
    expect(hiddenBy({ userId: 1, firstName: "cl_0106_00003", lastName: "Reyes" })).toEqual([
      "Placeholder name",
    ]);
    expect(hiddenBy({ userId: 1, firstName: "sl2_0575c_00012", lastName: "" })).toEqual(["Placeholder name"]);
    expect(hiddenBy({ userId: 1, firstName: "Maria", lastName: "cl_0106_00003" })).toEqual([]);
  });

  it("6. suspended accounts", () => {
    expect(hiddenBy({ userId: 1, suspended: true })).toEqual(["Suspended account"]);
    expect(hiddenBy({ userId: 1, suspended: null })).toEqual([]);
  });

  it("7. PC Center of Excellence or blank Dealer Level", () => {
    expect(hiddenBy({ userId: 1, profile: { level: "PC Center of Excellence" } })).toEqual([
      "COE or blank Dealer Level",
    ]);
    expect(hiddenBy({ userId: 1, profile: { level: "" } })).toEqual(["COE or blank Dealer Level"]);
    expect(hiddenBy({ userId: 1, profile: { level: "n/a" } })).toEqual(["COE or blank Dealer Level"]);
    expect(hiddenBy({ userId: 1, profile: { level: "Great Life Executive" } })).toEqual([]);
  });

  it("lists every rule that hides an account, once each", () => {
    expect(
      hiddenBy({ userId: 1, username: "admin.test", firstName: "Test", lastName: "Test", suspended: true }),
    ).toEqual(["Test, training or admin username", "Test or dummy name", "Suspended account"]);
  });

  it("keeps the Conso ID as stored: no leading-zero repair, placeholders are empty", () => {
    expect(view({ userId: 1, profile: { dealer_conso_id: " 99900077574 " } }).identifier).toBe("99900077574");
    expect(view({ userId: 1, profile: { dealer_conso_id: "N/A" } }).identifier).toBeNull();
  });

  it("matches patterns case-insensitively, whatever case the rule is written in", async () => {
    const { tenantConfigSchema } = await import("@/tenants/schema");
    const custom = tenantConfigSchema.parse({
      ...t,
      savedFilters: {
        f: { label: "F", hide: [{ field: "name", op: "matches", value: "PC SFLMS Live", label: "x" }] },
      },
      defaults: { savedFilter: "f" },
    });
    expect(
      classify(account({ userId: 1, firstName: "pc sflms live", lastName: "2" }), custom).failed,
    ).toEqual(["x"]);
  });

  it("shows the username as the Conso ID when the profile field is empty (display only)", async () => {
    const { shownIdentifier } = await import("@/domain/people");
    expect(shownIdentifier(view({ userId: 1, username: "077700099283" }))).toEqual({
      value: "077700099283",
      fromUsername: true,
    });
    expect(shownIdentifier(view({ userId: 1, profile: { dealer_conso_id: "088800099158" } }))).toEqual({
      value: "088800099158",
      fromUsername: false,
    });
  });

  it("records whether the LMS showed email and status", () => {
    const v = classify(account({ userId: 1 }), t);
    expect(v.emailKnown).toBe(false);
    expect(v.statusKnown).toBe(false);
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
  it("rejects saved-filter rules on region, branch or category, and bad values", () => {
    const base = { ...t, savedFilters: {} } as Record<string, unknown>;
    const bad = (cond: Record<string, unknown>) =>
      tenantConfigSchema.safeParse({
        ...base,
        savedFilters: { f: { label: "F", hide: [{ label: "x", ...cond }] } },
      }).success;
    expect(bad({ field: "region", op: "in", value: ["Visayas"] })).toBe(false);
    expect(bad({ field: "branch", op: "equals", value: "0032" })).toBe(false);
    expect(bad({ field: "level", op: "in", value: ["PC Center of Excellence"] })).toBe(true); // BES-465 exception
    expect(bad({ field: "username", op: "in", value: "one" })).toBe(false);
    expect(bad({ field: "username", op: "matches", value: "(" })).toBe(false);
    expect(bad({ field: "username", op: "in", value: ["admin"] })).toBe(true);
  });
});

describe("profile values", () => {
  it('treats placeholder text in profile fields as empty ("Not set")', () => {
    const v = view({ userId: 1, profile: { Region_Dropdown: "n/a", level: "None", branch_code: "-" } });
    expect(v.region).toBe("Not set");
    expect(v.level).toBe("Not set");
    expect(v.branch.label).toBe("Not set");
  });

  it('uses profile values verbatim and "Not set" for empty', () => {
    const v = view({
      userId: 1,
      profile: { Region_Dropdown: "Visayas 2", level: "", branch_code: "CUBAO (0101)" },
    });
    expect(v.region).toBe("Visayas 2");
    expect(v.level).toBe("Not set");
    expect(v.branch).toEqual({ label: "CUBAO (0101)", name: "CUBAO", code: "0101" });
  });

  it("branch keeps the stored label and exposes name + code", () => {
    expect(parseBranch("DAVAO (0575C)", "name_with_code", "Not set").code).toBe("0575c");
    expect(parseBranch("0032", "name_with_code", "Not set")).toEqual({
      label: "0032",
      name: null,
      code: "0032",
    });
    expect(parseBranch("777", "name_with_code", "Not set")).toEqual({ label: "777", name: null, code: null });
    expect(parseBranch(" ", "name_with_code", "Not set")).toEqual({
      label: "Not set",
      name: null,
      code: null,
    });
  });
});

describe("filters and similar values", () => {
  const v = view({
    userId: 1,
    profile: { Region_Dropdown: "Visayas 1", level: "Great Life Builder", branch_code: "CUBAO (0101)" },
  });
  const inc = (include: Record<string, string[]>) => matchesFilters(v, { include, exclude: {} }, "Not set");
  const exc = (exclude: Record<string, string[]>) => matchesFilters(v, { include: {}, exclude }, "Not set");
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
