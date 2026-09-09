import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service.js";
import { isCsvExportColumn } from "../csv-export.js";

interface BlueprintRow {
  id: string;
  resource_name: string;
  resource_type: "program" | "dataset";
  schema_name: string;
  table_name: string;
}

const quote = (value: string) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("Unsafe backup identifier");
  return `"${value}"`;
};

export function parseBackupYear(value?: string): number | null {
  if (!value || value === "all") return null;
  if (!/^\d{4}$/.test(value)) throw new BadRequestException("Year must contain four digits or be 'all'");
  return Number(value);
}

export function backupYearExpression(resourceType: BlueprintRow["resource_type"]): string {
  return resourceType === "program"
    ? `EXTRACT(YEAR FROM COALESCE("enrollment_date", "incident_date", "source_last_updated_at"::date))::integer`
    : `CASE WHEN "period" ~ '^[0-9]{4}' THEN substring("period", 1, 4)::integer END`;
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined
    ? ""
    : typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

@Injectable()
export class BackupService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  private async blueprint(blueprintId: string): Promise<BlueprintRow> {
    const blueprint = await this.database.query<BlueprintRow>(
      `SELECT b.id, s.resource_name, s.resource_type, b.schema_name, b.table_name
       FROM schema_blueprints b JOIN metadata_snapshots s ON s.id=b.snapshot_id
       WHERE b.id=$1 AND b.status='applied'`,
      [blueprintId]
    );
    const item = blueprint.rows[0];
    if (!item) throw new NotFoundException("Applied data table not found");
    return item;
  }

  async years(blueprintId: string): Promise<{ blueprintId: string; years: number[] }> {
    const item = await this.blueprint(blueprintId);
    const expression = backupYearExpression(item.resource_type);
    const result = await this.database.query<{ year: number }>(
      `SELECT year FROM (
         SELECT DISTINCT ${expression} AS year
         FROM ${quote(item.schema_name)}.${quote(item.table_name)}
       ) available WHERE year IS NOT NULL ORDER BY year DESC`
    );
    return { blueprintId, years: result.rows.map((row) => Number(row.year)) };
  }

  private async rows(blueprintId: string, requestedYear?: string) {
    const item = await this.blueprint(blueprintId);
    const year = parseBackupYear(requestedYear);
    const expression = backupYearExpression(item.resource_type);
    const result = await this.database.query<Record<string, unknown>>(
      `SELECT * FROM ${quote(item.schema_name)}.${quote(item.table_name)}
       ${year === null ? "" : `WHERE ${expression} = $1`}`,
      year === null ? [] : [year]
    );
    return { item, year, result };
  }

  async data(blueprintId: string, requestedYear?: string) {
    const { item, year, result } = await this.rows(blueprintId, requestedYear);
    const yearLabel = year ?? "all-years";
    return {
      filename: `${item.table_name}-${yearLabel}-${new Date().toISOString().slice(0, 10)}.json`,
      payload: {
        format: "dhis2-interoperability-data-backup/v1",
        exportedAt: new Date().toISOString(),
        selectedYear: year ?? "all",
        blueprintId,
        resourceName: item.resource_name,
        table: `${item.schema_name}.${item.table_name}`,
        rowCount: result.rowCount ?? result.rows.length,
        rows: result.rows
      }
    };
  }

  async csv(blueprintId: string, requestedYear?: string) {
    const { item, year, result } = await this.rows(blueprintId, requestedYear);
    const headers = result.fields.map((field) => field.name).filter(isCsvExportColumn);
    const lines = [headers.map(csvCell).join(",")];
    for (const row of result.rows) lines.push(headers.map((header) => csvCell(row[header])).join(","));
    return {
      filename: `${item.table_name}-${year ?? "all-years"}-${new Date().toISOString().slice(0, 10)}.csv`,
      content: lines.join("\n")
    };
  }

  async configuration() {
    const [connections, snapshots, blueprints, columns, definitions, schedules] = await Promise.all([
      this.database.query<Record<string, unknown>>(`SELECT id,name,role,base_url,auth_type,dhis2_version,system_name,capabilities,last_test_status,last_tested_at,is_active,created_at,updated_at FROM dhis2_connections ORDER BY created_at`),
      this.database.query<Record<string, unknown>>(`SELECT id,connection_id,resource_type,resource_uid,resource_name,dhis2_version,metadata_hash,captured_at FROM metadata_snapshots ORDER BY captured_at`),
      this.database.query<Record<string, unknown>>(`SELECT * FROM schema_blueprints ORDER BY created_at`),
      this.database.query<Record<string, unknown>>(`SELECT * FROM schema_columns ORDER BY blueprint_id,ordinal`),
      this.database.query<Record<string, unknown>>(`SELECT * FROM sync_definitions ORDER BY created_at`),
      this.database.query<Record<string, unknown>>(`SELECT * FROM sync_schedules ORDER BY created_at`)
    ]);
    return {
      filename: `dhis2-control-plane-${new Date().toISOString().slice(0, 10)}.json`,
      payload: {
        format: "dhis2-interoperability-configuration-backup/v1",
        exportedAt: new Date().toISOString(),
        note: "Credentials and encryption material are intentionally excluded.",
        connections: connections.rows,
        metadataSnapshots: snapshots.rows,
        schemaBlueprints: blueprints.rows,
        schemaColumns: columns.rows,
        syncDefinitions: definitions.rows,
        syncSchedules: schedules.rows
      }
    };
  }
}
