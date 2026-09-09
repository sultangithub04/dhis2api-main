import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { ReportDefinitionSummary, ReportPage, ResourceType, SchemaColumnPreview } from "@dhis-sync/contracts";
import { DatabaseService } from "../database/database.service.js";
import { isCsvExportColumn } from "../csv-export.js";

interface ReportRow {
  blueprint_id: string;
  resource_name: string;
  resource_type: ResourceType;
  schema_name: string;
  table_name: string;
  columns: SchemaColumnPreview[];
  metadata: Record<string, unknown>;
}

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const array = (value: unknown): JsonRecord[] => Array.isArray(value) ? value.map(record) : [];
const firstText = (...values: unknown[]): string => {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return "";
};

function displayLookups(metadata: JsonRecord): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();
  const add = (source: JsonRecord) => {
    const uid = firstText(source.id);
    const options = array(record(source.optionSet).options);
    if (!uid || !options.length) return;
    const values = new Map<string, string>();
    for (const option of options) {
      const code = firstText(option.code, option.id);
      if (code) values.set(code, firstText(option.displayName, option.name, option.code, option.id));
    }
    result.set(uid, values);
  };
  for (const item of array(metadata.programTrackedEntityAttributes)) add(record(item.trackedEntityAttribute));
  for (const stage of array(metadata.programStages)) {
    for (const item of array(stage.programStageDataElements)) add(record(item.dataElement));
  }
  for (const item of array(metadata.dataSetElements)) add(record(item.dataElement));
  return result;
}

function browserRows(report: ReportRow, sourceRows: JsonRecord[]): JsonRecord[] {
  const optionLookups = displayLookups(report.metadata);
  const orgNames = new Map(array(report.metadata.organisationUnits).map((org) => [
    firstText(org.id),
    firstText(org.displayName, org.name, org.id)
  ]));
  return sourceRows.map((sourceRow) => {
    const row = { ...sourceRow };
    const orgUid = firstText(row.org_unit_uid);
    if (orgUid && orgNames.has(orgUid)) row.org_unit_name = orgNames.get(orgUid);
    for (const column of report.columns ?? []) {
      if (!column.sourceUid || row[column.columnName] === null || row[column.columnName] === undefined) continue;
      const lookup = optionLookups.get(column.sourceUid);
      if (!lookup) continue;
      const rawValue = String(row[column.columnName]);
      row[`${column.columnName}__code`] = row[column.columnName];
      row[column.columnName] = lookup.get(rawValue) ?? row[column.columnName];
    }
    return row;
  });
}

const quote = (value: string) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new BadRequestException("Unsafe report identifier");
  return `"${value}"`;
};

function csvCell(value: unknown): string {
  const text = value === null || value === undefined
    ? ""
    : typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

@Injectable()
export class ReportService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  private async definitions(): Promise<ReportRow[]> {
    const result = await this.database.query<ReportRow>(
      `SELECT b.id AS blueprint_id, s.resource_name, s.resource_type, b.schema_name, b.table_name, s.metadata,
       (SELECT jsonb_agg(jsonb_build_object(
          'ordinal', c.ordinal, 'columnName', c.column_name, 'sqlType', c.sql_type,
          'sourceKind', c.source_kind, 'sourceUid', c.source_uid, 'stageUid', c.stage_uid,
          'repeatPolicy', c.repeat_policy, 'nullable', c.nullable, 'isFilterable', c.is_filterable,
          'label', c.label, 'mapping', c.mapping
        ) ORDER BY c.ordinal) FROM schema_columns c WHERE c.blueprint_id = b.id) AS columns
       FROM schema_blueprints b JOIN metadata_snapshots s ON s.id = b.snapshot_id
       WHERE b.status = 'applied'
         AND b.id = (
           SELECT newest.id FROM schema_blueprints newest
           WHERE newest.status='applied'
             AND newest.schema_name=b.schema_name AND newest.table_name=b.table_name
           ORDER BY newest.applied_at DESC NULLS LAST, newest.created_at DESC
           LIMIT 1
         )
       ORDER BY b.applied_at DESC`
    );
    return result.rows;
  }

  async list(): Promise<ReportDefinitionSummary[]> {
    const definitions = await this.definitions();
    return Promise.all(definitions.map(async (item) => {
      const count = await this.database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${quote(item.schema_name)}.${quote(item.table_name)}`
      );
      return {
        blueprintId: item.blueprint_id,
        resourceName: item.resource_name,
        resourceType: item.resource_type,
        schemaName: item.schema_name,
        tableName: item.table_name,
        columns: item.columns ?? [],
        rowCount: Number(count.rows[0]?.count ?? 0)
      };
    }));
  }

  private async get(id: string): Promise<ReportRow> {
    const found = (await this.definitions()).find((item) => item.blueprint_id === id);
    if (!found) throw new NotFoundException("Applied report schema not found");
    return found;
  }

  async data(id: string, query: Record<string, string | undefined>, exportAll = false): Promise<ReportPage> {
    const report = await this.get(id);
    const columns = report.columns ?? [];
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = exportAll ? 50_000 : Math.min(500, Math.max(10, Number(query.pageSize) || 50));
    const conditions: string[] = [];
    const values: unknown[] = [];
    const add = (value: unknown) => { values.push(value); return `$${values.length}`; };
    const textColumns = columns.filter((column) => /text|varchar/.test(column.sqlType) && column.columnName !== "raw_payload");
    if (query.search?.trim() && textColumns.length) {
      const parameter = add(`%${query.search.trim()}%`);
      conditions.push(`(${textColumns.map((column) => `${quote(column.columnName)} ILIKE ${parameter}`).join(" OR ")})`);
    }
    if (query.facility?.trim()) {
      const parameter = add(`%${query.facility.trim()}%`);
      conditions.push(`(org_unit_uid ILIKE ${parameter} OR org_unit_name ILIKE ${parameter})`);
    }
    const patientColumn = columns.find((column) => Array.isArray(column.mapping.semanticHints) && column.mapping.semanticHints.includes("patient_identifier"));
    if (query.patientId?.trim() && patientColumn) {
      conditions.push(`${quote(patientColumn.columnName)} ILIKE ${add(`%${query.patientId.trim()}%`)}`);
    }
    const dateColumn = columns.find((column) => column.columnName === "enrollment_date")
      ?? columns.find((column) => column.sqlType === "date" && column.isFilterable);
    if (dateColumn && query.dateFrom) conditions.push(`${quote(dateColumn.columnName)} >= ${add(query.dateFrom)}`);
    if (dateColumn && query.dateTo) conditions.push(`${quote(dateColumn.columnName)} <= ${add(query.dateTo)}`);
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const table = `${quote(report.schema_name)}.${quote(report.table_name)}`;
    const count = await this.database.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}${where}`, values);
    const order = columns.some((column) => column.columnName === "source_last_updated_at")
      ? " ORDER BY source_last_updated_at DESC NULLS LAST"
      : "";
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT * FROM ${table}${where}${order} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      values
    );
    return { columns, rows: browserRows(report, rows.rows), total: Number(count.rows[0]?.count ?? 0), page, pageSize };
  }

  async csv(id: string, query: Record<string, string | undefined>): Promise<{ filename: string; content: string }> {
    const report = await this.get(id);
    const page = await this.data(id, query, true);
    const selected = page.columns.filter((column) => isCsvExportColumn(column.columnName));
    const lines = [selected.map((column) => csvCell(column.label)).join(",")];
    for (const row of page.rows) lines.push(selected.map((column) => csvCell(row[column.columnName])).join(","));
    return { filename: `${report.table_name}.csv`, content: lines.join("\n") };
  }
}
