import { Inject, Injectable } from "@nestjs/common";
import type {
  CreateSyncDefinitionInput,
  SyncDefinitionSummary,
  SyncRunSummary,
  SyncScheduleSummary,
  UpdateSyncDefinitionInput,
  UpsertScheduleInput
} from "@dhis-sync/contracts";
import { DatabaseService } from "../database/database.service.js";
import type { PoolClient } from "pg";

interface DefinitionRow {
  id: string;
  name: string;
  source_connection_id: string;
  source_connection_name: string;
  blueprint_id: string;
  resource_type: "tracker" | "aggregate" | "metadata";
  resource_uid: string;
  resource_name: string;
  schema_name: string;
  table_name: string;
  batch_size: number;
  conflict_policy: string;
  filters: Record<string, unknown>;
  is_active: boolean;
  created_at: Date;
  schedule: SyncScheduleSummary | null;
  latest_run: SyncRunSummary | null;
}

const definitionSelect = `
  SELECT d.id, d.name, d.source_connection_id, c.name AS source_connection_name,
    d.blueprint_id, d.resource_type, d.resource_uid, s.resource_name,
    b.schema_name, b.table_name, d.batch_size, d.conflict_policy, d.filters,
    d.is_active, d.created_at,
    CASE WHEN sc.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', sc.id, 'intervalMinutes', replace(split_part(sc.cron_expression, ' ', 1), '*/', '')::int,
      'timezone', sc.timezone, 'executionLimit', sc.execution_limit,
      'executionCount', sc.execution_count, 'isActive', sc.is_active,
      'nextRunAt', sc.next_run_at, 'lastRunAt', sc.last_run_at
    ) END AS schedule,
    CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', r.id, 'definitionId', r.sync_definition_id, 'triggerType', r.trigger_type,
      'status', r.status, 'recordsRead', r.records_read, 'recordsWritten', r.records_written,
      'recordsSkipped', r.records_skipped, 'recordsFailed', r.records_failed,
      'errorSummary', r.error_summary, 'queuedAt', r.queued_at,
      'startedAt', r.started_at, 'finishedAt', r.finished_at
    ) END AS latest_run
  FROM sync_definitions d
  JOIN dhis2_connections c ON c.id = d.source_connection_id
  JOIN schema_blueprints b ON b.id = d.blueprint_id
  JOIN metadata_snapshots s ON s.id = b.snapshot_id
  LEFT JOIN LATERAL (
    SELECT * FROM sync_schedules x WHERE x.sync_definition_id = d.id
    ORDER BY x.created_at DESC LIMIT 1
  ) sc ON true
  LEFT JOIN LATERAL (
    SELECT * FROM sync_runs x WHERE x.sync_definition_id = d.id
    ORDER BY x.queued_at DESC LIMIT 1
  ) r ON true`;

function iso(value: unknown): string | null {
  if (!value) return null;
  return new Date(String(value)).toISOString();
}

function mapSchedule(value: SyncScheduleSummary | null): SyncScheduleSummary | null {
  if (!value) return null;
  return { ...value, nextRunAt: iso(value.nextRunAt), lastRunAt: iso(value.lastRunAt) };
}

function mapRun(value: SyncRunSummary | null): SyncRunSummary | null {
  if (!value) return null;
  return {
    ...value,
    queuedAt: iso(value.queuedAt) ?? new Date().toISOString(),
    startedAt: iso(value.startedAt),
    finishedAt: iso(value.finishedAt)
  };
}

function mapDefinition(row: DefinitionRow): SyncDefinitionSummary {
  return {
    id: row.id,
    name: row.name,
    sourceConnectionId: row.source_connection_id,
    sourceConnectionName: row.source_connection_name,
    blueprintId: row.blueprint_id,
    resourceType: row.resource_type,
    resourceUid: row.resource_uid,
    resourceName: row.resource_name,
    tableName: `${row.schema_name}.${row.table_name}`,
    batchSize: row.batch_size,
    conflictPolicy: row.conflict_policy,
    isActive: row.is_active,
    schedule: mapSchedule(row.schedule),
    latestRun: mapRun(row.latest_run),
    createdAt: row.created_at.toISOString()
  };
}

@Injectable()
export class SyncRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async list(): Promise<SyncDefinitionSummary[]> {
    const result = await this.database.query<DefinitionRow>(`${definitionSelect} ORDER BY d.created_at DESC`);
    return result.rows.map(mapDefinition);
  }

  async find(id: string): Promise<(DefinitionRow & { metadata: Record<string, unknown>; columns: Record<string, unknown>[] }) | null> {
    const result = await this.database.query<DefinitionRow & { metadata: Record<string, unknown>; columns: Record<string, unknown>[] }>(
      `SELECT base.*, s.metadata,
       (SELECT jsonb_agg(to_jsonb(col) ORDER BY col.ordinal) FROM schema_columns col WHERE col.blueprint_id = base.blueprint_id) AS columns
       FROM (${definitionSelect}) base
       JOIN schema_blueprints b ON b.id = base.blueprint_id
       JOIN metadata_snapshots s ON s.id = b.snapshot_id
       WHERE base.id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  async create(input: CreateSyncDefinitionInput): Promise<SyncDefinitionSummary> {
    const result = await this.database.query<{ id: string }>(
      `INSERT INTO sync_definitions (
        name, source_connection_id, blueprint_id, resource_type, resource_uid,
        conflict_policy, batch_size, filters
      )
      SELECT $1, $2, b.id,
        CASE WHEN s.resource_type = 'program' THEN 'tracker' ELSE 'aggregate' END,
        s.resource_uid, $4, $5, $6
      FROM schema_blueprints b JOIN metadata_snapshots s ON s.id = b.snapshot_id
      WHERE b.id = $3 AND b.status = 'applied'
      RETURNING id`,
      [input.name, input.sourceConnectionId, input.blueprintId, input.conflictPolicy, input.batchSize, JSON.stringify(input.filters)]
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("The blueprint must be applied before creating a sync");
    const created = (await this.list()).find((item) => item.id === id);
    if (!created) throw new Error("Created sync could not be loaded");
    return created;
  }

  async updateDefinition(id: string, input: UpdateSyncDefinitionInput): Promise<SyncDefinitionSummary> {
    const result = await this.database.query(
      `UPDATE sync_definitions d SET name=$2, source_connection_id=$3, blueprint_id=b.id,
       resource_type=CASE WHEN s.resource_type='program' THEN 'tracker' ELSE 'aggregate' END,
       resource_uid=s.resource_uid, conflict_policy=$5, batch_size=$6, is_active=$7, updated_at=now()
       FROM schema_blueprints b JOIN metadata_snapshots s ON s.id=b.snapshot_id
       WHERE d.id=$1 AND b.id=$4 AND b.status='applied'`,
      [id, input.name, input.sourceConnectionId, input.blueprintId, input.conflictPolicy, input.batchSize, input.isActive]
    );
    if (!result.rowCount) throw new Error("Sync or applied blueprint not found");
    const updated = (await this.list()).find((item) => item.id === id);
    if (!updated) throw new Error("Updated sync could not be loaded");
    return updated;
  }

  async upsertSchedule(definitionId: string, input: UpsertScheduleInput): Promise<SyncDefinitionSummary> {
    const cron = `*/${input.intervalMinutes} * * * *`;
    const nextRunAt = input.isActive
      ? new Date()
      : null;
    await this.database.transaction(async (client) => {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM sync_schedules WHERE sync_definition_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [definitionId]
      );
      if (existing.rows[0]) {
        await client.query(
          `UPDATE sync_schedules SET cron_expression=$2, timezone=$3, execution_limit=$4,
            execution_count=0, is_active=$5, next_run_at=$6, updated_at=now() WHERE id=$1`,
          [existing.rows[0].id, cron, input.timezone, input.executionLimit, input.isActive, nextRunAt]
        );
      } else {
        await client.query(
          `INSERT INTO sync_schedules (sync_definition_id, cron_expression, timezone, execution_limit, is_active, next_run_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [definitionId, cron, input.timezone, input.executionLimit, input.isActive, nextRunAt]
        );
      }
    });
    const updated = (await this.list()).find((item) => item.id === definitionId);
    if (!updated) throw new Error("Sync definition not found");
    return updated;
  }

  async createRun(definitionId: string, triggerType: "manual" | "scheduled", scheduleId?: string): Promise<string> {
    const result = await this.database.query<{ id: string }>(
      `INSERT INTO sync_runs (sync_definition_id, schedule_id, trigger_type, status, started_at)
       VALUES ($1,$2,$3,'running',now()) RETURNING id`,
      [definitionId, scheduleId ?? null, triggerType]
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Could not create sync run");
    return id;
  }

  async finishRun(id: string, counts: { read: number; written: number; skipped: number; failed: number }, error?: string): Promise<void> {
    await this.database.query(
      `UPDATE sync_runs SET status=$2, records_read=$3, records_written=$4,
       records_skipped=$5, records_failed=$6, error_summary=$7, finished_at=now() WHERE id=$1`,
      [id, error ? "failed" : counts.failed ? "partially_succeeded" : "succeeded", counts.read, counts.written, counts.skipped, counts.failed, error ?? null]
    );
  }

  async updateRunProgress(id: string, counts: { read: number; written: number; skipped: number; failed: number }): Promise<void> {
    await this.database.query(
      `UPDATE sync_runs SET records_read=$2, records_written=$3,
       records_skipped=$4, records_failed=$5 WHERE id=$1 AND status='running'`,
      [id, counts.read, counts.written, counts.skipped, counts.failed]
    );
  }

  async failInterruptedRuns(): Promise<number> {
    const result = await this.database.query(
      `UPDATE sync_runs SET status='failed', records_failed=GREATEST(records_failed, 1),
       error_summary='Synchronization was interrupted because the API service restarted',
       finished_at=now() WHERE status IN ('queued', 'running')`
    );
    return result.rowCount ?? 0;
  }

  async dueSchedules(excludedDefinitionIds: string[] = []): Promise<{ definitionId: string; scheduleId: string; intervalMinutes: number }[]> {
    const result = await this.database.query<{ definition_id: string; schedule_id: string; interval_minutes: number }>(
      `UPDATE sync_schedules sc SET
        next_run_at = CASE
          WHEN sc.execution_limit IS NOT NULL AND sc.execution_count + 1 >= sc.execution_limit THEN NULL
          ELSE now() + (replace(split_part(sc.cron_expression, ' ', 1), '*/', '') || ' minutes')::interval
        END,
        is_active = CASE
          WHEN sc.execution_limit IS NOT NULL AND sc.execution_count + 1 >= sc.execution_limit THEN false
          ELSE sc.is_active
        END,
        last_run_at = now(), execution_count = execution_count + 1, updated_at = now()
       FROM sync_definitions d
       WHERE d.id = sc.sync_definition_id AND d.is_active AND sc.is_active
         AND NOT (d.id = ANY($1::uuid[]))
         AND sc.next_run_at <= now()
         AND (sc.execution_limit IS NULL OR sc.execution_count < sc.execution_limit)
       RETURNING sc.sync_definition_id AS definition_id, sc.id AS schedule_id,
         replace(split_part(sc.cron_expression, ' ', 1), '*/', '')::int AS interval_minutes`,
      [excludedDefinitionIds]
    );
    return result.rows.map((row) => ({ definitionId: row.definition_id, scheduleId: row.schedule_id, intervalMinutes: row.interval_minutes }));
  }

  async deleteSchedule(definitionId: string): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM sync_schedules WHERE sync_definition_id = $1`,
      [definitionId]
    );
    return Boolean(result.rowCount);
  }

  async clearRuns(definitionId: string): Promise<number> {
    const result = await this.database.query(
      `DELETE FROM sync_runs WHERE sync_definition_id = $1`,
      [definitionId]
    );
    return result.rowCount ?? 0;
  }

  async deleteDefinition(definitionId: string): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM sync_definitions WHERE id = $1`,
      [definitionId]
    );
    return Boolean(result.rowCount);
  }

  query<T extends Record<string, unknown>>(sql: string, values: unknown[] = []) {
    return this.database.query<T>(sql, values);
  }

  transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.database.transaction(operation);
  }
}
