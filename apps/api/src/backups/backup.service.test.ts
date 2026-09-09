import { describe, expect, it } from "vitest";
import { backupYearExpression, parseBackupYear } from "./backup.service.js";

describe("backup year filtering", () => {
  it("accepts all years or a four digit year", () => {
    expect(parseBackupYear()).toBeNull();
    expect(parseBackupYear("all")).toBeNull();
    expect(parseBackupYear("2026")).toBe(2026);
  });

  it("rejects invalid year input", () => {
    expect(() => parseBackupYear("26")).toThrow("Year must contain four digits");
    expect(() => parseBackupYear("2026 OR 1=1")).toThrow("Year must contain four digits");
  });

  it("uses tracker dates and aggregate periods for available years", () => {
    expect(backupYearExpression("program")).toContain("enrollment_date");
    expect(backupYearExpression("program")).toContain("incident_date");
    expect(backupYearExpression("dataset")).toContain("period");
  });
});
