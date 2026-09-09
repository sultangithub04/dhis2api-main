export const CSV_EXCLUDED_COLUMNS = new Set([
  "record_id",
  "org_unit_uid",
  "tracked_entity_uid",
  "enrollment_uid",
  "enrollment_date",
  "incident_date",
  "source_last_updated_at",
  "sync_run_id",
  "raw_payload"
]);

export function isCsvExportColumn(columnName: string): boolean {
  return !CSV_EXCLUDED_COLUMNS.has(columnName);
}
