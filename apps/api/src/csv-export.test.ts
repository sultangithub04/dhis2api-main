import { describe, expect, it } from "vitest";
import { isCsvExportColumn } from "./csv-export.js";

describe("CSV export columns", () => {
  it.each([
    "record_id",
    "org_unit_uid",
    "tracked_entity_uid",
    "enrollment_uid",
    "enrollment_date",
    "incident_date",
    "source_last_updated_at",
    "sync_run_id",
    "raw_payload"
  ])("excludes the internal column %s", (columnName) => {
    expect(isCsvExportColumn(columnName)).toBe(false);
  });

  it("keeps report data and display columns", () => {
    expect(isCsvExportColumn("org_unit_name")).toBe(true);
    expect(isCsvExportColumn("patient_name")).toBe(true);
    expect(isCsvExportColumn("malaria_test_result_name")).toBe(true);
  });
});
