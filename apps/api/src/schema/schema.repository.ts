import { Inject, Injectable } from "@nestjs/common";
import type {
  FlattenStrategy,
  ResourceType,
  SchemaBlueprintSummary,
  SchemaColumnPreview
} from "@dhis-sync/contracts";
import { DatabaseService } from "../database/database.service.js";
import { createTableSql, reconcileTableColumnsSql } from "./schema-generator.js";

interface BlueprintRow {
  id: string;
  snapshot_id: string;
  resource_name: string;
  resource_type: ResourceType;
  schema_name: string;
  table_name: string;
  strategy: FlattenStrategy;
  status: SchemaBlueprintSummary["status"];
  version: number;
  generated_by: SchemaBlueprintSummary["generatedBy"];
  applied_at: Date | null;
  created_at: Date;
}

interface ColumnRow {
  blueprint_id: string;
  ordinal: number;
  column_name: string;
  sql_type: string;
  source_kind: SchemaColumnPreview["sourceKind"];
  source_uid: string | null;
  stage_uid: string | null;
  repeat_policy: string | null;
  nullable: boolean;
  is_filterable: boolean;
  label: string;
  mapping: Record<string, unknown>;
}

function mapColumn(row: ColumnRow): SchemaColumnPreview {
  return {
    ordinal: row.ordinal,
    columnName: row.column_name,
    sqlType: row.sql_type,
    sourceKind: row.source_kind,
    sourceUid: row.source_uid,
    stageUid: row.stage_uid,
    repeatPolicy: row.repeat_policy,
    nullable: row.nullable,
    isFilterable: row.is_filterable,
    label: row.label,
    mapping: row.mapping
  };
}

function mapBlueprint(row: BlueprintRow, columns: SchemaColumnPreview[]): SchemaBlueprintSummary {
  return {
    id: row.id,
    snapshotId: row.snapshot_id,
    resourceName: row.resource_name,
    resourceType: row.resource_type,
    schemaName: row.schema_name,
    tableName: row.table_name,
    strategy: row.strategy,
    status: row.status,
    version: row.version,
    generatedBy: row.generated_by,
    columns,
    sqlPreview: createTableSql(row.schema_name, row.table_name, columns),
    createdAt: row.created_at.toISOString(),
    appliedAt: row.applied_at?.toISOString() ?? null
  };
}

const blueprintSelect = `
  SELECT b.id, b.snapshot_id, s.resource_name, s.resource_type,
    b.schema_name, b.table_name, b.strategy, b.status, b.version,
    b.generated_by, b.applied_at, b.created_at
  FROM schema_blueprints b
  JOIN metadata_snapshots s ON s.id = b.snapshot_id`;

@Injectable()
export class SchemaRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  private async columnsFor(ids: string[]): Promise<Map<string, SchemaColumnPreview[]>> {
    const byBlueprint = new Map<string, SchemaColumnPreview[]>();
    if (!ids.length) return byBlueprint;
    const result = await this.database.query<ColumnRow>(
      `SELECT blueprint_id, ordinal, column_name, sql_type, source_kind,
        source_uid, stage_uid, repeat_policy, nullable, is_filterable, label, mapping
      FROM schema_columns WHERE blueprint_id = ANY($1::uuid[]) ORDER BY ordinal`,
      [ids]
    );
    for (const row of result.rows) {
      const current = byBlueprint.get(row.blueprint_id) ?? [];
      current.push(mapColumn(row));
      byBlueprint.set(row.blueprint_id, current);
    }
    return byBlueprint;
  }

  async list(): Promise<SchemaBlueprintSummary[]> {
    const result = await this.database.query<BlueprintRow>(`${blueprintSelect} ORDER BY b.created_at DESC`);
    const columns = await this.columnsFor(result.rows.map((row) => row.id));
    return result.rows.map((row) => mapBlueprint(row, columns.get(row.id) ?? []));
  }

  async findById(id: string): Promise<SchemaBlueprintSummary | null> {
    const result = await this.database.query<BlueprintRow>(`${blueprintSelect} WHERE b.id = $1`, [id]);
    const row = result.rows[0];
    if (!row) return null;
    const columns = await this.columnsFor([id]);
    return mapBlueprint(row, columns.get(id) ?? []);
  }

  async create(input: {
    snapshotId: string;
    tableName: string;
    strategy: FlattenStrategy;
    columns: SchemaColumnPreview[];
  }): Promise<SchemaBlueprintSummary> {
    const id = await this.database.transaction(async (client) => {
      const versionResult = await client.query<{ version: number }>(
        `SELECT COALESCE(max(version), 0) + 1 AS version
         FROM schema_blueprints WHERE snapshot_id = $1 AND table_name = $2`,
        [input.snapshotId, input.tableName]
      );
      const version = versionResult.rows[0]?.version ?? 1;
      const blueprint = await client.query<{ id: string }>(
        `INSERT INTO schema_blueprints (
          snapshot_id, schema_name, table_name, strategy, version, generated_by
        ) VALUES ($1, 'dhis_data', $2, $3, $4, 'rules') RETURNING id`,
        [input.snapshotId, input.tableName, input.strategy, version]
      );
      const blueprintId = blueprint.rows[0]?.id;
      if (!blueprintId) throw new Error("Blueprint insert returned no row");
      for (const column of input.columns) {
        await client.query(
          `INSERT INTO schema_columns (
            blueprint_id, ordinal, column_name, sql_type, source_kind,
            source_uid, stage_uid, repeat_policy, nullable, is_filterable, label, mapping
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            blueprintId, column.ordinal, column.columnName, column.sqlType,
            column.sourceKind, column.sourceUid, column.stageUid, column.repeatPolicy,
            column.nullable, column.isFilterable, column.label, JSON.stringify(column.mapping)
          ]
        );
      }
      return blueprintId;
    });
    const created = await this.findById(id);
    if (!created) throw new Error("Created blueprint could not be loaded");
    return created;
  }

  async apply(id: string): Promise<SchemaBlueprintSummary> {
    const blueprint = await this.findById(id);
    if (!blueprint) throw new Error("Blueprint not found");
    await this.database.transaction(async (client) => {
      await client.query(blueprint.sqlPreview ?? createTableSql(blueprint.schemaName, blueprint.tableName, blueprint.columns));
      for (const statement of reconcileTableColumnsSql(blueprint.schemaName, blueprint.tableName, blueprint.columns)) {
        await client.query(statement);
      }
      await client.query(
        `UPDATE schema_blueprints SET status = 'applied', applied_at = now(), updated_at = now() WHERE id = $1`,
        [id]
      );
    });
    const applied = await this.findById(id);
    if (!applied) throw new Error("Applied blueprint could not be loaded");
    return applied;
  }

  async updateColumns(id: string, columns: { columnName: string; label: string; isFilterable: boolean }[]): Promise<SchemaBlueprintSummary> {
    await this.database.transaction(async (client) => {
      for (const column of columns) {
        await client.query(
          `UPDATE schema_columns SET label=$3, is_filterable=$4 WHERE blueprint_id=$1 AND column_name=$2`,
          [id, column.columnName, column.label.trim(), column.isFilterable]
        );
      }
      await client.query(`UPDATE schema_blueprints SET updated_at=now() WHERE id=$1`, [id]);
    });
    const updated = await this.findById(id);
    if (!updated) throw new Error("Updated blueprint could not be loaded");
    return updated;
  }

  async dropTable(id: string): Promise<{ deletedSyncDefinitions: number }> {
    const blueprint = await this.findById(id);
    if (!blueprint) throw new Error("Blueprint not found");
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(blueprint.schemaName) || !/^[a-z_][a-z0-9_]{0,62}$/.test(blueprint.tableName)) {
      throw new Error("Unsafe table identifier");
    }
    return this.database.transaction(async (client) => {
      const deletedSyncs = await client.query(
        `DELETE FROM sync_definitions
         WHERE blueprint_id IN (
           SELECT id FROM schema_blueprints WHERE schema_name=$1 AND table_name=$2
         )`,
        [blueprint.schemaName, blueprint.tableName]
      );
      await client.query(`DROP TABLE IF EXISTS "${blueprint.schemaName}"."${blueprint.tableName}"`);
      await client.query(
        `UPDATE schema_blueprints SET status = 'retired', updated_at = now()
         WHERE schema_name=$1 AND table_name=$2`,
        [blueprint.schemaName, blueprint.tableName]
      );
      return { deletedSyncDefinitions: deletedSyncs.rowCount ?? 0 };
    });
  }

  async syncDependencyCount(id: string): Promise<number> {
    const result = await this.database.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM sync_definitions d
       WHERE EXISTS (
         SELECT 1
         FROM schema_blueprints dependency
         JOIN schema_blueprints target
           ON target.schema_name=dependency.schema_name AND target.table_name=dependency.table_name
         WHERE dependency.id=d.blueprint_id AND target.id=$1
       )`,
      [id]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async deleteBlueprint(id: string): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const found = await client.query<{ snapshot_id: string }>(
        `SELECT snapshot_id FROM schema_blueprints WHERE id=$1`,
        [id]
      );
      const snapshotId = found.rows[0]?.snapshot_id;
      if (!snapshotId) return false;
      await client.query(`DELETE FROM schema_blueprints WHERE id=$1`, [id]);
      await client.query(
        `DELETE FROM metadata_snapshots s WHERE s.id=$1
         AND NOT EXISTS (SELECT 1 FROM schema_blueprints b WHERE b.snapshot_id=s.id)`,
        [snapshotId]
      );
      return true;
    });
  }
}
