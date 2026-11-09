import { describe, expect, it } from "vitest";
import { formatInZone, inWindow, resolveWindow, startOfDay } from "@/domain/time";

const TZ = "Asia/Manila";
const NOW = startOfDay("2026-11-03", TZ) + 10 * 3600; // 10:00 Manila

describe("time windows (Asia/Manila)", () => {
  it("computes local midnight", () => {
    expect(new Date(startOfDay("2026-10-01", TZ) * 1000).toISOString()).toBe("2026-09-30T16:00:00.000Z");
    expect(formatInZone(startOfDay("2026-10-01", TZ), TZ)).toBe("2026-10-01T00:00:00+08:00");
  });

  it("rejects bad dates", () => {
    expect(() => startOfDay("2026-02-30", TZ)).toThrow();
    expect(() => startOfDay("01/02/2026", TZ)).toThrow();
  });

  it("recent_days is an exact rolling window", () => {
    const w = resolveWindow({ recent_days: 30 }, TZ, NOW)!;
    expect(w.semantics).toBe("accessed_since");
    expect(w.from).toBe(NOW - 30 * 86400);
    expect(inWindow(NOW - 29 * 86400, w)).toBe(true);
    expect(inWindow(NOW - 31 * 86400, w)).toBe(false);
    expect(inWindow(null, w)).toBe(false);
  });

  it("from with to today or later is still exact", () => {
    expect(resolveWindow({ from: "2026-10-01", to: "2026-11-03" }, TZ, NOW)!.semantics).toBe(
      "accessed_since",
    );
  });

  it("a past range is labelled last_access_in_range with an inclusive end date", () => {
    const w = resolveWindow({ from: "2026-10-01", to: "2026-10-31" }, TZ, NOW)!;
    expect(w.semantics).toBe("last_access_in_range");
    expect(w.description).toMatch(/NOT/);
    expect(inWindow(startOfDay("2026-10-31", TZ) + 86399, w)).toBe(true);
    expect(inWindow(startOfDay("2026-11-01", TZ), w)).toBe(false);
  });

  it("validates combinations", () => {
    expect(resolveWindow({}, TZ, NOW)).toBeNull();
    expect(() => resolveWindow({ recent_days: 7, from: "2026-10-01" }, TZ, NOW)).toThrow();
    expect(() => resolveWindow({ to: "2026-10-01" }, TZ, NOW)).toThrow();
    expect(() => resolveWindow({ from: "2026-10-10", to: "2026-10-01" }, TZ, NOW)).toThrow();
    expect(() => resolveWindow({ from: "2027-01-01" }, TZ, NOW)).toThrow();
  });
});
