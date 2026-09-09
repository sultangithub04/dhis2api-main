import { describe, expect, it, vi } from "vitest";
import { aggregateDateRanges, flattenProgramEvent, flattenTracker, splitDateRange, SyncService, trackerPageSize } from "./sync.service.js";
import type { SyncRepository } from "./sync.repository.js";
import type { ConnectionService } from "../connections/connection.service.js";

const column = (overrides: Record<string, unknown>) => ({
  column_name: "value",
  sql_type: "text",
  source_kind: "data_element",
  source_uid: "de123456789",
  stage_uid: "stage123456",
  repeat_policy: "single",
  mapping: {},
  ...overrides
});

describe("aggregate sync time selection", () => {
  it("splits inclusive ranges without gaps or overlaps", () => {
    expect(splitDateRange("2025-12-31", "2026-01-03", 2)).toEqual([
      { startDate: "2025-12-31", endDate: "2026-01-01" },
      { startDate: "2026-01-02", endDate: "2026-01-03" }
    ]);
  });

  it("uses bounded requests for the full historical range", () => {
    const ranges = aggregateDateRanges({}, new Date("2026-09-03T00:00:00.000Z"));
    expect(ranges[0]).toEqual({ startDate: "1900-01-01", endDate: "1901-01-01" });
    expect(ranges.at(-1)?.endDate).toBe("2026-09-03");
    for (let index = 1; index < ranges.length; index += 1) {
      const previousEnd = new Date(`${ranges[index - 1]!.endDate}T00:00:00.000Z`).getTime();
      const currentStart = new Date(`${ranges[index]!.startDate}T00:00:00.000Z`).getTime();
      expect(currentStart - previousEnd).toBe(86_400_000);
    }
  });

  it("writes each downloaded chunk to staging before atomically replacing the report table", async () => {
    const getDataValueSet = vi.fn().mockResolvedValue({ dataValues: [
      { period: "199901", orgUnit: "DiszpKrYNg8", dataElement: "de123456789", value: "7" },
      { period: "201001", orgUnit: "DiszpKrYNg8", dataElement: "de123456789", value: "8" }
    ] });
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = {
      find: vi.fn().mockResolvedValue({
        id: "sync-id", source_connection_id: "connection-id", resource_type: "aggregate",
        resource_uid: "j5Gj5Trw7PS", schema_name: "dhis_data", table_name: "test_history",
        filters: { startDate: "1999-01-01", endDate: "1999-01-01" },
        metadata: { organisationUnits: [{ id: "DiszpKrYNg8", name: "Clinic A" }] },
        columns: [
          column({ column_name: "period", source_kind: "system", source_uid: null }),
          column({ column_name: "cases", sql_type: "integer" })
        ]
      }),
      createRun: vi.fn().mockResolvedValue("run-id"),
      updateRunProgress: vi.fn().mockResolvedValue(undefined),
      finishRun: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(async (callback: (client: { query: typeof query }) => Promise<void>) => callback({ query })),
      query,
      list: vi.fn().mockResolvedValue([{ id: "sync-id" }])
    };
    const connections = { getAuthenticatedClient: vi.fn().mockResolvedValue({ getDataValueSet }) };
    const service = new SyncService(
      repository as unknown as SyncRepository, connections as unknown as ConnectionService
    );

    await service.run("sync-id");

    expect(getDataValueSet).toHaveBeenCalledWith(expect.objectContaining({
      dataSetUid: "j5Gj5Trw7PS", startDate: "1999-01-01", endDate: "1999-01-01",
      orgUnitUids: ["DiszpKrYNg8"], includeChildren: false, timeoutMs: 45_000
    }));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("CREATE UNLOGGED TABLE"));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("VALUES ($1,$2),($3,$4)"), ["199901", 7, "201001", 8]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("TRUNCATE TABLE"));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("DROP TABLE"));
    expect(repository.finishRun).toHaveBeenCalledWith("run-id", { read: 2, written: 2, skipped: 0, failed: 0 });
  });

  it("bisects a date range after a timeout instead of completing with zero rows", async () => {
    const getDataValueSet = vi.fn()
      .mockRejectedValueOnce(new Error("Could not reach DHIS2 after 3 attempts: timeout"))
      .mockResolvedValueOnce({ dataValues: [{ period: "202601", orgUnit: "DiszpKrYNg8", dataElement: "de123456789", value: "1" }] })
      .mockResolvedValueOnce({ dataValues: [{ period: "202601", orgUnit: "DiszpKrYNg8", dataElement: "de123456789", value: "2" }] });
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = {
      find: vi.fn().mockResolvedValue({
        id: "sync-id", source_connection_id: "connection-id", resource_type: "aggregate",
        resource_uid: "j5Gj5Trw7PS", schema_name: "dhis_data", table_name: "test_history",
        filters: { startDate: "2026-01-01", endDate: "2026-01-02", chunkDays: 2 },
        metadata: { organisationUnits: [{ id: "DiszpKrYNg8", name: "Clinic A" }] },
        columns: [column({ column_name: "period", source_kind: "system", source_uid: null }), column({ column_name: "cases", sql_type: "integer" })]
      }),
      createRun: vi.fn().mockResolvedValue("run-id"), updateRunProgress: vi.fn(), finishRun: vi.fn(), query,
      transaction: vi.fn(async (callback: (client: { query: typeof query }) => Promise<void>) => callback({ query })),
      list: vi.fn().mockResolvedValue([{ id: "sync-id" }])
    };
    const service = new SyncService(repository as unknown as SyncRepository, {
      getAuthenticatedClient: vi.fn().mockResolvedValue({ getDataValueSet })
    } as unknown as ConnectionService);

    await service.run("sync-id");

    expect(getDataValueSet).toHaveBeenCalledTimes(3);
    expect(getDataValueSet.mock.calls.slice(1).map((call) => ({ startDate: call[0].startDate, endDate: call[0].endDate }))).toEqual([
      { startDate: "2026-01-01", endDate: "2026-01-01" },
      { startDate: "2026-01-02", endDate: "2026-01-02" }
    ]);
    expect(repository.finishRun).toHaveBeenCalledWith("run-id", { read: 2, written: 2, skipped: 0, failed: 0 });
  });

  it("fails an unexpected empty aggregate refresh without truncating the live table", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = {
      find: vi.fn().mockResolvedValue({
        id: "sync-id", source_connection_id: "connection-id", resource_type: "aggregate",
        resource_uid: "j5Gj5Trw7PS", schema_name: "dhis_data", table_name: "test_history",
        filters: { startDate: "2026-01-01", endDate: "2026-01-01" },
        metadata: { organisationUnits: [{ id: "DiszpKrYNg8", name: "Clinic A" }] },
        columns: [column({ column_name: "period", source_kind: "system", source_uid: null })]
      }),
      createRun: vi.fn().mockResolvedValue("run-id"), updateRunProgress: vi.fn(), finishRun: vi.fn(), query,
      transaction: vi.fn(), list: vi.fn().mockResolvedValue([{ id: "sync-id" }])
    };
    const service = new SyncService(repository as unknown as SyncRepository, {
      getAuthenticatedClient: vi.fn().mockResolvedValue({ getDataValueSet: vi.fn().mockResolvedValue({ dataValues: [] }) })
    } as unknown as ConnectionService);

    await service.run("sync-id");

    expect(repository.transaction).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining("TRUNCATE TABLE"));
    expect(repository.finishRun).toHaveBeenCalledWith(
      "run-id",
      { read: 0, written: 0, skipped: 0, failed: 1 },
      expect.stringContaining("existing report table was preserved")
    );
  });
});

describe("tracker payload flattening", () => {
  it("maps program attributes stored on the matching enrollment", () => {
    const row = flattenTracker({
      trackedEntity: "tracked12345",
      enrollments: [
        { program: "Other123456", enrolledAt: "2025-01-01", attributes: [{ attribute: "attr1234567", value: "wrong" }] },
        { program: "Prog1234567", enrolledAt: "2026-01-01", attributes: [{ attribute: "attr1234567", value: "correct" }] }
      ]
    }, [column({ column_name: "patient_name", source_kind: "attribute", source_uid: "attr1234567", stage_uid: null })] as never, new Map(), "run-id", "Prog1234567");

    expect(row.patient_name).toBe("correct");
    expect(row.enrollment_date).toBe("2026-01-01");
  });

  it("maps a WITHOUT_REGISTRATION event to one relational row", () => {
    const row = flattenProgramEvent({
      event: "event123456",
      programStage: "stage123456",
      orgUnit: "orgunit1234",
      occurredAt: "2026-08-10T00:00:00.000Z",
      dataValues: [{ dataElement: "de123456789", value: "42" }]
    }, [column({})] as never, new Map([["orgunit1234", "Clinic A"]]), "run-id");

    expect(row).toMatchObject({
      event_uid: "event123456",
      event_date: "2026-08-10",
      org_unit_name: "Clinic A",
      value: "42"
    });
  });

  it("reduces page size for programs with many fields and repeatable stages", () => {
    const metadata = {
      programTrackedEntityAttributes: Array.from({ length: 50 }, () => ({})),
      programStages: [{
        repeatable: true,
        programStageDataElements: Array.from({ length: 20 }, () => ({}))
      }]
    };

    expect(trackerPageSize(250, metadata)).toBe(181);
    expect(trackerPageSize(50, metadata)).toBe(50);
  });

  it("restarts tracker pagination with a smaller page after a payload timeout", async () => {
    const getTrackerEntities = vi.fn()
      .mockRejectedValueOnce(new Error("Could not reach DHIS2 after 3 attempts: timeout"))
      .mockResolvedValueOnce({
        instances: [{ trackedEntity: "tracked12345", enrollments: [] }],
        page: 1, pageSize: 2, total: 1, hasNextPage: false
      });
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = {
      find: vi.fn().mockResolvedValue({
        id: "sync-id", source_connection_id: "connection-id", resource_type: "tracker",
        resource_uid: "Prog1234567", schema_name: "dhis_data", table_name: "test_tracker",
        batch_size: 250, filters: { trackerPageSize: 4 },
        metadata: { programType: "WITH_REGISTRATION", organisationUnits: [] },
        columns: [column({ column_name: "tracked_entity_uid", source_kind: "system", source_uid: null })]
      }),
      createRun: vi.fn().mockResolvedValue("run-id"), updateRunProgress: vi.fn(), finishRun: vi.fn(), query,
      transaction: vi.fn(async (callback: (client: { query: typeof query }) => Promise<void>) => callback({ query })),
      list: vi.fn().mockResolvedValue([{ id: "sync-id" }])
    };
    const service = new SyncService(repository as unknown as SyncRepository, {
      getAuthenticatedClient: vi.fn().mockResolvedValue({ getTrackerEntities })
    } as unknown as ConnectionService);

    await service.run("sync-id");

    expect(getTrackerEntities.mock.calls).toEqual([
      ["Prog1234567", 1, 4, 60_000],
      ["Prog1234567", 1, 2, 60_000]
    ]);
    expect(query.mock.calls.some((call) => String(call[0]).includes("TRUNCATE TABLE") && String(call[0]).includes("sync_test_tracker"))).toBe(true);
    expect(repository.finishRun).toHaveBeenCalledWith("run-id", { read: 1, written: 1, skipped: 0, failed: 0 });
  });

  it("does not publish an unexpectedly empty tracker response", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = {
      find: vi.fn().mockResolvedValue({
        id: "sync-id", source_connection_id: "connection-id", resource_type: "tracker",
        resource_uid: "Prog1234567", schema_name: "dhis_data", table_name: "test_tracker",
        batch_size: 50, filters: {}, metadata: { programType: "WITH_REGISTRATION", organisationUnits: [] },
        columns: [column({ column_name: "tracked_entity_uid", source_kind: "system", source_uid: null })]
      }),
      createRun: vi.fn().mockResolvedValue("run-id"), updateRunProgress: vi.fn(), finishRun: vi.fn(), query,
      transaction: vi.fn(), list: vi.fn().mockResolvedValue([{ id: "sync-id" }])
    };
    const service = new SyncService(repository as unknown as SyncRepository, {
      getAuthenticatedClient: vi.fn().mockResolvedValue({
        getTrackerEntities: vi.fn().mockResolvedValue({ instances: [], page: 1, pageSize: 50, hasNextPage: false })
      })
    } as unknown as ConnectionService);

    await service.run("sync-id");

    expect(repository.transaction).not.toHaveBeenCalled();
    expect(repository.finishRun).toHaveBeenCalledWith(
      "run-id", { read: 0, written: 0, skipped: 0, failed: 1 }, expect.stringContaining("tracked entities or events")
    );
  });
});
