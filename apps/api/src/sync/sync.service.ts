import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { CreateSyncDefinitionInput, SyncDefinitionSummary, UpdateSyncDefinitionInput, UpsertScheduleInput } from "@dhis-sync/contracts";
import type { PoolClient } from "pg";
import { Dhis2HttpError } from "@dhis-sync/dhis2-client";
import { ConnectionService } from "../connections/connection.service.js";
import { SyncRepository } from "./sync.repository.js";

type JsonRecord = Record<string, unknown>;
type Column = {
  column_name: string; sql_type: string; source_kind: string; source_uid: string | null;
  stage_uid: string | null; repeat_policy: string | null; mapping: JsonRecord;
};

const record = (value: unknown): JsonRecord => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const array = (value: unknown): JsonRecord[] => Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown): string | null => value === undefined || value === null || value === "" ? null : String(value);
const quote = (value: string) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("Unsafe SQL identifier");
  return `"${value}"`;
};

type DateRange = { startDate: string; endDate: string };
type RunCounts = { read: number; written: number; skipped: number; failed: number };
type StoredSyncDefinition = NonNullable<Awaited<ReturnType<SyncRepository["find"]>>>;

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);
const parseIsoDate = (value: string): Date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid sync date: ${value}`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || isoDate(parsed) !== value) throw new Error(`Invalid sync date: ${value}`);
  return parsed;
};

export function splitDateRange(startDate: string, endDate: string, maximumDays = 366): DateRange[] {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  if (start > end) throw new Error("Sync start date must be before or equal to the end date");
  const chunkDays = Math.min(732, Math.max(1, Math.trunc(maximumDays)));
  const ranges: DateRange[] = [];
  for (let cursor = start; cursor <= end;) {
    const chunkEnd = new Date(Math.min(end.getTime(), cursor.getTime() + (chunkDays - 1) * 86_400_000));
    ranges.push({ startDate: isoDate(cursor), endDate: isoDate(chunkEnd) });
    cursor = new Date(chunkEnd.getTime() + 86_400_000);
  }
  return ranges;
}

export function aggregateDateRanges(filters: JsonRecord, now = new Date()): DateRange[] {
  const useAllHistory = filters.allPeriods === true || (!text(filters.startDate) && !text(filters.endDate));
  const startDate = useAllHistory ? text(filters.historyStartDate) ?? "1900-01-01" : text(filters.startDate);
  const endDate = useAllHistory ? isoDate(now) : text(filters.endDate);
  if (!startDate || !endDate) throw new Error("Both startDate and endDate are required for a date-limited sync");
  const requestedChunkDays = Number(filters.chunkDays ?? 366);
  return splitDateRange(startDate, endDate, Number.isFinite(requestedChunkDays) ? requestedChunkDays : 366);
}

function splitRangeInHalf(range: DateRange): [DateRange, DateRange] | null {
  const start = parseIsoDate(range.startDate);
  const end = parseIsoDate(range.endDate);
  const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000);
  if (days < 1) return null;
  const leftEnd = new Date(start.getTime() + Math.floor(days / 2) * 86_400_000);
  const rightStart = new Date(leftEnd.getTime() + 86_400_000);
  return [
    { startDate: range.startDate, endDate: isoDate(leftEnd) },
    { startDate: isoDate(rightStart), endDate: range.endDate }
  ];
}

function canSplitRequestError(error: unknown): boolean {
  if (error instanceof Dhis2HttpError) return [408, 413, 429, 500, 502, 503, 504].includes(error.status);
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|abort|network|fetch|socket|ECONNRESET|reach DHIS2/i.test(message);
}

export function trackerPageSize(configuredBatchSize: number, metadata: JsonRecord): number {
  const attributes = array(metadata.programTrackedEntityAttributes).length;
  const stages = array(metadata.programStages);
  const eventFields = stages.reduce((total, stage) => {
    const elementCount = array(stage.programStageDataElements).length;
    // Repeating stages can make one tracked-entity payload substantially larger.
    return total + elementCount * (stage.repeatable === true ? 3 : 1);
  }, 0);
  const estimatedFieldsPerEntity = Math.max(1, attributes + eventFields);
  const payloadAwareLimit = Math.max(10, Math.floor(20_000 / estimatedFieldsPerEntity));
  return Math.max(1, Math.min(250, Math.trunc(configuredBatchSize), payloadAwareLimit));
}

function stagingTableName(table: string, runId: string): string {
  const suffix = runId.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().slice(0, 12);
  return `sync_${table.slice(0, 44)}_${suffix}`.slice(0, 63);
}

function coerce(value: unknown, sqlType: string): unknown {
  const raw = text(value);
  if (raw === null) return null;
  if (sqlType === "integer") return Number.isFinite(Number(raw)) ? Math.trunc(Number(raw)) : null;
  if (sqlType === "numeric") return Number.isFinite(Number(raw)) ? Number(raw) : null;
  if (sqlType === "boolean") return ["true", "1", "yes"].includes(raw.toLowerCase()) ? true : ["false", "0", "no"].includes(raw.toLowerCase()) ? false : null;
  if (sqlType === "date") return raw.slice(0, 10);
  if (sqlType === "timestamptz") return Number.isNaN(Date.parse(raw)) ? null : new Date(raw).toISOString();
  return raw;
}

function assignSourceValue(row: JsonRecord, column: Column, value: unknown): void {
  const rawValue = coerce(value, column.sql_type);
  row[column.column_name] = rawValue;
  const displayColumnName = text(column.mapping.displayColumnName);
  if (!displayColumnName) return;
  const option = array(column.mapping.optionValues).find((item) =>
    String(item.code ?? item.id ?? "") === String(value ?? "")
  );
  row[displayColumnName] = text(option?.name ?? option?.displayName ?? value);
}

function latest(items: JsonRecord[], first: boolean): JsonRecord | undefined {
  return [...items].sort((a, b) => {
    const left = Date.parse(String(a.updatedAt ?? a.lastUpdated ?? a.occurredAt ?? a.eventDate ?? a.enrolledAt ?? a.enrollmentDate ?? a.createdAt ?? a.created ?? 0));
    const right = Date.parse(String(b.updatedAt ?? b.lastUpdated ?? b.occurredAt ?? b.eventDate ?? b.enrolledAt ?? b.enrollmentDate ?? b.createdAt ?? b.created ?? 0));
    return first ? left - right : right - left;
  })[0];
}

function friendlySyncError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Sync failed";
  const unauthorized = message.match(/Current user is not authorized to read data from selected program:\s*([A-Za-z0-9]+)/i);
  if (unauthorized) {
    return `DHIS2 permission denied for Program ${unauthorized[1]}. Grant this user Program sharing access and data-view access to the assigned organisation units, then run the sync again.`;
  }
  return message.length > 800 ? `${message.slice(0, 797)}...` : message;
}

export function flattenTracker(entity: JsonRecord, columns: Column[], orgNames: Map<string, string>, runId: string, programUid?: string): JsonRecord {
  const allEnrollments = array(entity.enrollments);
  const programEnrollments = programUid
    ? allEnrollments.filter((item) => item.program === programUid)
    : allEnrollments;
  const enrollment = latest(programEnrollments.length ? programEnrollments : allEnrollments, false) ?? {};
  const attributes = new Map([
    ...array(entity.attributes),
    ...array(enrollment.attributes)
  ].map((item) => [String(item.attribute), item.value]));
  const events = array(enrollment.events);
  const orgUid = text(enrollment.orgUnit ?? entity.orgUnit);
  const row: JsonRecord = {
    org_unit_uid: orgUid,
    org_unit_name: orgUid ? orgNames.get(orgUid) ?? orgUid : null,
    tracked_entity_uid: text(entity.trackedEntity ?? entity.trackedEntityInstance),
    enrollment_uid: text(enrollment.enrollment),
    enrollment_date: text(enrollment.enrolledAt ?? enrollment.enrollmentDate)?.slice(0, 10) ?? null,
    incident_date: text(enrollment.occurredAt ?? enrollment.incidentDate)?.slice(0, 10) ?? null,
    source_last_updated_at: text(entity.updatedAt ?? entity.lastUpdated ?? enrollment.updatedAt ?? enrollment.lastUpdated),
    sync_run_id: runId,
    raw_payload: entity
  };
  for (const column of columns) {
    if (column.source_kind === "attribute" && column.source_uid) {
      assignSourceValue(row, column, attributes.get(column.source_uid));
    }
    if (column.source_kind === "data_element" && column.source_uid && column.stage_uid) {
      const stageEvents = events.filter((event) => event.programStage === column.stage_uid);
      const chosen = latest(stageEvents, column.repeat_policy === "first") ?? {};
      const value = array(chosen.dataValues).find((item) => item.dataElement === column.source_uid)?.value;
      assignSourceValue(row, column, value);
    }
  }
  return row;
}

export function flattenProgramEvent(event: JsonRecord, columns: Column[], orgNames: Map<string, string>, runId: string): JsonRecord {
  const orgUid = text(event.orgUnit);
  const row: JsonRecord = {
    org_unit_uid: orgUid,
    org_unit_name: orgUid ? orgNames.get(orgUid) ?? orgUid : null,
    event_uid: text(event.event),
    event_date: text(event.occurredAt ?? event.eventDate)?.slice(0, 10) ?? null,
    tracked_entity_uid: null,
    enrollment_uid: text(event.enrollment),
    enrollment_date: null,
    incident_date: text(event.occurredAt ?? event.eventDate)?.slice(0, 10) ?? null,
    source_last_updated_at: text(event.updatedAt ?? event.lastUpdated),
    sync_run_id: runId,
    raw_payload: event
  };
  const values = new Map(array(event.dataValues).map((item) => [String(item.dataElement), item.value]));
  for (const column of columns) {
    if (column.source_kind === "data_element" && column.source_uid
      && (!column.stage_uid || column.stage_uid === event.programStage)) {
      assignSourceValue(row, column, values.get(column.source_uid));
    }
  }
  return row;
}

function canUseLegacyTrackerFallback(error: unknown): boolean {
  return error instanceof Dhis2HttpError && [404, 405, 501].includes(error.status);
}

function flattenAggregate(payload: JsonRecord, columns: Column[], orgNames: Map<string, string>, runId: string): JsonRecord[] {
  const rows = new Map<string, JsonRecord>();
  for (const value of array(payload.dataValues)) {
    const orgUnit = text(value.orgUnit ?? payload.orgUnit);
    const period = text(value.period ?? payload.period);
    const coc = text(value.categoryOptionCombo);
    const aoc = text(value.attributeOptionCombo);
    const key = `${orgUnit}|${period}|${coc}|${aoc}`;
    const row = rows.get(key) ?? {
      org_unit_uid: orgUnit, org_unit_name: orgUnit ? orgNames.get(orgUnit) ?? orgUnit : null, period,
      category_option_combo_uid: coc, attribute_option_combo_uid: aoc,
      source_last_updated_at: text(value.lastUpdated), sync_run_id: runId, raw_payload: []
    };
    const column = columns.find((item) => item.source_uid === value.dataElement);
    if (column) assignSourceValue(row, column, value.value);
    (row.raw_payload as JsonRecord[]).push(value);
    rows.set(key, row);
  }
  return [...rows.values()];
}

@Injectable()
export class SyncService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private schedulerPolling = false;
  private readonly runningDefinitions = new Set<string>();
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @Inject(SyncRepository) private readonly repository: SyncRepository,
    @Inject(ConnectionService) private readonly connections: ConnectionService
  ) {}

  async onModuleInit(): Promise<void> {
    const interrupted = await this.repository.failInterruptedRuns();
    if (interrupted) this.logger.warn(`Marked ${interrupted} interrupted synchronization run(s) as failed`);
    await this.runDueSchedules();
    this.timer = setInterval(() => void this.runDueSchedules(), 5_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  list(): Promise<SyncDefinitionSummary[]> { return this.repository.list(); }

  async create(input: CreateSyncDefinitionInput): Promise<SyncDefinitionSummary> {
    try { return await this.repository.create(input); }
    catch (error) { throw new BadRequestException(error instanceof Error ? error.message : "Could not create sync"); }
  }

  async update(id: string, input: UpdateSyncDefinitionInput): Promise<SyncDefinitionSummary> {
    if (this.runningDefinitions.has(id)) throw new BadRequestException("Wait for the current run to finish before editing this sync");
    if (!await this.repository.find(id)) throw new NotFoundException("Sync definition not found");
    try { return await this.repository.updateDefinition(id, input); }
    catch (error) { throw new BadRequestException(error instanceof Error ? error.message : "Could not update sync"); }
  }

  async schedule(id: string, input: UpsertScheduleInput): Promise<SyncDefinitionSummary> {
    try {
      const updated = await this.repository.upsertSchedule(id, input);
      if (input.isActive) setTimeout(() => void this.runDueSchedules(), 0);
      return updated;
    }
    catch (error) { throw new BadRequestException(error instanceof Error ? error.message : "Could not save schedule"); }
  }

  async deleteSchedule(id: string): Promise<{ deleted: true }> {
    if (!await this.repository.deleteSchedule(id)) throw new NotFoundException("Schedule not found");
    return { deleted: true };
  }

  async clearRuns(id: string): Promise<{ deleted: number }> {
    if (!await this.repository.find(id)) throw new NotFoundException("Sync definition not found");
    return { deleted: await this.repository.clearRuns(id) };
  }

  async delete(id: string, confirmation: string): Promise<{ deleted: true }> {
    const definition = await this.repository.find(id);
    if (!definition) throw new NotFoundException("Sync definition not found");
    if (confirmation !== definition.name) throw new BadRequestException(`Type ${definition.name} to confirm deletion`);
    if (this.runningDefinitions.has(id)) throw new BadRequestException("Wait for the current run to finish before deleting this sync");
    if (!await this.repository.deleteDefinition(id)) throw new NotFoundException("Sync definition not found");
    return { deleted: true };
  }

  async run(id: string, triggerType: "manual" | "scheduled" = "manual", scheduleId?: string): Promise<SyncDefinitionSummary> {
    if (this.runningDefinitions.has(id)) throw new BadRequestException("This synchronization is already running");
    const definition = await this.repository.find(id);
    if (!definition) throw new NotFoundException("Sync definition not found");
    const runId = await this.repository.createRun(id, triggerType, scheduleId);
    this.runningDefinitions.add(id);
    const stagingTable = stagingTableName(definition.table_name, runId);
    let stagingPrepared = false;
    try {
      const counts: RunCounts = { read: 0, written: 0, skipped: 0, failed: 0 };
      try {
        const client = await this.connections.getAuthenticatedClient(definition.source_connection_id);
        const columns = (definition.columns ?? []) as unknown as Column[];
        await this.prepareStagingTable(definition.schema_name, definition.table_name, stagingTable);
        stagingPrepared = true;
        if (definition.resource_type === "tracker") {
          await this.downloadTrackerPages(client, definition, columns, stagingTable, runId, counts);
        } else if (definition.resource_type === "aggregate") {
          const filters = definition.filters ?? {};
          const startDate = text(filters.startDate);
          const endDate = text(filters.endDate);
          const configuredOrgUnit = text(filters.orgUnitUid);
          const assignedOrgUnits = configuredOrgUnit
            ? [configuredOrgUnit]
            : array(definition.metadata.organisationUnits).map((org) => text(org.id)).filter((uid): uid is string => Boolean(uid));
          if (!assignedOrgUnits.length) {
            throw new Error("This Data Set has no organisation units available to the connected DHIS2 user");
          }
          const orgNames = new Map(array(definition.metadata.organisationUnits).map((org) => [String(org.id), String(org.displayName ?? org.name ?? org.id)]));
          const ranges = aggregateDateRanges({ ...filters, ...(startDate ? { startDate } : {}), ...(endDate ? { endDate } : {}) });
          const requestedOrgBatchSize = Number(filters.orgUnitBatchSize ?? 50);
          const orgBatchSize = Math.min(100, Math.max(1, Number.isFinite(requestedOrgBatchSize) ? Math.trunc(requestedOrgBatchSize) : 50));
          for (const range of ranges) {
            for (let offset = 0; offset < assignedOrgUnits.length; offset += orgBatchSize) {
              await this.downloadAggregateChunk(
                client,
                definition.resource_uid,
                range,
                assignedOrgUnits.slice(offset, offset + orgBatchSize),
                Boolean(configuredOrgUnit),
                async (batchValues) => {
                  counts.read += batchValues.length;
                  const batchRows = flattenAggregate({ dataValues: batchValues }, columns, orgNames, runId);
                  counts.written += await this.insertRows(definition.schema_name, stagingTable, columns, batchRows);
                  await this.repository.updateRunProgress(runId, counts);
                }
              );
            }
          }
        } else throw new Error("Metadata sync is not supported by this table definition");

        if (counts.read === 0 && definition.filters?.allowEmptySource !== true) {
          const sourceRecords = definition.resource_type === "tracker" ? "tracked entities or events" : "data values";
          throw new Error(
            `DHIS2 returned no ${sourceRecords} for the requested scope. `
            + "The existing report table was preserved. Verify Program or Data Set sharing, organisation-unit data-view access, and filters; "
            + "set allowEmptySource=true only when an empty refresh is intentional."
          );
        }
        await this.commitStagingTable(definition.schema_name, definition.table_name, stagingTable, columns);
        stagingPrepared = false;
        await this.repository.finishRun(runId, counts);
      } catch (error) {
        const message = friendlySyncError(error);
        counts.failed = Math.max(1, counts.failed);
        await this.repository.finishRun(runId, counts, message);
        this.logger.error(`Sync ${id} failed: ${message}`);
      } finally {
        if (stagingPrepared) {
          await this.dropStagingTable(definition.schema_name, stagingTable).catch((error) =>
            this.logger.warn(`Could not remove staging table ${stagingTable}: ${error instanceof Error ? error.message : String(error)}`)
          );
          stagingPrepared = false;
        }
      }
      const updated = (await this.repository.list()).find((item) => item.id === id);
      if (!updated) throw new NotFoundException("Sync definition not found after run");
      return updated;
    } finally {
      this.runningDefinitions.delete(id);
    }
  }

  private async prepareStagingTable(schema: string, table: string, stagingTable: string): Promise<void> {
    await this.repository.query(
      `CREATE UNLOGGED TABLE ${quote(schema)}.${quote(stagingTable)} `
      + `(LIKE ${quote(schema)}.${quote(table)} INCLUDING DEFAULTS INCLUDING GENERATED)`
    );
  }

  private async insertRows(schema: string, table: string, columns: Column[], rows: JsonRecord[]): Promise<number> {
    if (!rows.length) return 0;
    const names = columns.map((column) => column.column_name).filter((name) => name !== "record_id");
    if (!names.length) throw new Error("The generated table has no writable columns");
    // Leave headroom below PostgreSQL's 65,535 bind-parameter limit.
    const rowsPerInsert = Math.max(1, Math.min(250, Math.floor(60_000 / names.length)));
    for (let offset = 0; offset < rows.length; offset += rowsPerInsert) {
      const batch = rows.slice(offset, offset + rowsPerInsert);
      const values: unknown[] = [];
      const tuples = batch.map((row) => {
        const placeholders = names.map((name) => {
          const value = row[name] === undefined ? null : row[name];
          values.push(name === "raw_payload" && value !== null ? JSON.stringify(value) : value);
          return `$${values.length}`;
        });
        return `(${placeholders.join(",")})`;
      });
      await this.repository.query(
        `INSERT INTO ${quote(schema)}.${quote(table)} (${names.map(quote).join(",")}) VALUES ${tuples.join(",")}`,
        values
      );
    }
    return rows.length;
  }

  private async commitStagingTable(schema: string, table: string, stagingTable: string, columns: Column[]): Promise<void> {
    const names = columns.map((column) => column.column_name);
    if (!names.length) throw new Error("The generated table has no columns");
    await this.repository.transaction<void>(async (client: PoolClient) => {
      await client.query(`LOCK TABLE ${quote(schema)}.${quote(table)} IN ACCESS EXCLUSIVE MODE`);
      await client.query(`TRUNCATE TABLE ${quote(schema)}.${quote(table)}`);
      await client.query(
        `INSERT INTO ${quote(schema)}.${quote(table)} (${names.map(quote).join(",")}) `
        + `SELECT ${names.map(quote).join(",")} FROM ${quote(schema)}.${quote(stagingTable)}`
      );
      await client.query(`DROP TABLE ${quote(schema)}.${quote(stagingTable)}`);
    });
  }

  private dropStagingTable(schema: string, stagingTable: string): Promise<unknown> {
    return this.repository.query(`DROP TABLE IF EXISTS ${quote(schema)}.${quote(stagingTable)}`);
  }

  private async downloadAggregateChunk(
    client: Awaited<ReturnType<ConnectionService["getAuthenticatedClient"]>>,
    dataSetUid: string,
    range: DateRange,
    orgUnitUids: string[],
    includeChildren: boolean,
    consume: (values: JsonRecord[]) => Promise<void>
  ): Promise<void> {
    try {
      const response = await client.getDataValueSet({
        dataSetUid,
        startDate: range.startDate,
        endDate: range.endDate,
        orgUnitUids,
        includeChildren,
        timeoutMs: 45_000
      });
      await consume(array(response.dataValues));
    } catch (error) {
      if (!canSplitRequestError(error)) throw error;
      const splitRange = splitRangeInHalf(range);
      if (splitRange) {
        this.logger.warn(`Aggregate request ${range.startDate}..${range.endDate} was too large; retrying smaller date ranges`);
        for (const part of splitRange) {
          await this.downloadAggregateChunk(client, dataSetUid, part, orgUnitUids, includeChildren, consume);
        }
        return;
      }
      if (orgUnitUids.length > 1) {
        const middle = Math.ceil(orgUnitUids.length / 2);
        this.logger.warn(`Aggregate request for ${orgUnitUids.length} organisation units was too large; retrying smaller groups`);
        await this.downloadAggregateChunk(client, dataSetUid, range, orgUnitUids.slice(0, middle), includeChildren, consume);
        await this.downloadAggregateChunk(client, dataSetUid, range, orgUnitUids.slice(middle), includeChildren, consume);
        return;
      }
      throw error;
    }
  }

  private async downloadTrackerPages(
    client: Awaited<ReturnType<ConnectionService["getAuthenticatedClient"]>>,
    definition: StoredSyncDefinition,
    columns: Column[],
    stagingTable: string,
    runId: string,
    counts: RunCounts
  ): Promise<void> {
    const orgNames = new Map(
      array(definition.metadata.organisationUnits)
        .map((org) => [String(org.id), String(org.displayName ?? org.name ?? org.id)] as const)
    );
    const isEventProgram = text(definition.metadata.programType) === "WITHOUT_REGISTRATION";
    const requestedPageSize = Number(definition.filters?.trackerPageSize ?? definition.batch_size);
    let pageSize = trackerPageSize(
      Number.isFinite(requestedPageSize) ? requestedPageSize : definition.batch_size,
      definition.metadata
    );

    while (true) {
      let page = 1;
      let useLegacyTracker = false;
      try {
        do {
          let response;
          let batchRows: JsonRecord[];
          if (isEventProgram) {
            response = await client.getTrackerEvents(definition.resource_uid, page, pageSize, 60_000);
            batchRows = response.instances.map((event) => flattenProgramEvent(event, columns, orgNames, runId));
          } else {
            if (useLegacyTracker) {
              response = await client.getLegacyTrackerEntities(definition.resource_uid, page, pageSize, 60_000);
            } else {
              try {
                response = await client.getTrackerEntities(definition.resource_uid, page, pageSize, 60_000);
              } catch (modernError) {
                if (!canUseLegacyTrackerFallback(modernError)) throw modernError;
                useLegacyTracker = true;
                response = await client.getLegacyTrackerEntities(definition.resource_uid, page, pageSize, 60_000);
              }
            }
            batchRows = response.instances.map((entity) =>
              flattenTracker(entity, columns, orgNames, runId, definition.resource_uid)
            );
          }
          counts.read += response.instances.length;
          counts.written += await this.insertRows(definition.schema_name, stagingTable, columns, batchRows);
          await this.repository.updateRunProgress(runId, counts);
          if (!response.hasNextPage) return;
          page += 1;
          if (page > 100_000) throw new Error("DHIS2 tracker paging safety limit reached");
        } while (true);
      } catch (error) {
        if (!canSplitRequestError(error) || pageSize <= 1) throw error;
        const smallerPageSize = Math.max(1, Math.floor(pageSize / 2));
        this.logger.warn(
          `Tracker page ${page} timed out at ${pageSize} records; restarting safely with page size ${smallerPageSize}`
        );
        // Page size changes alter page offsets, so restart from page 1 to prevent
        // skipped or duplicated tracked entities. The live table is still intact.
        await this.repository.query(`TRUNCATE TABLE ${quote(definition.schema_name)}.${quote(stagingTable)}`);
        counts.read = 0;
        counts.written = 0;
        counts.skipped = 0;
        counts.failed = 0;
        await this.repository.updateRunProgress(runId, counts);
        pageSize = smallerPageSize;
      }
    }
  }

  private async runDueSchedules(): Promise<void> {
    if (this.schedulerPolling) return;
    this.schedulerPolling = true;
    try {
      for (const due of await this.repository.dueSchedules([...this.runningDefinitions])) {
        if (!this.runningDefinitions.has(due.definitionId)) {
          await this.run(due.definitionId, "scheduled", due.scheduleId);
        }
      }
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : "Scheduled sync polling failed");
    } finally {
      this.schedulerPolling = false;
    }
  }
}
