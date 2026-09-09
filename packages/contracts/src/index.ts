import { z } from "zod";

export const ConnectionRoleSchema = z.enum(["source", "destination", "bidirectional"]);
export const AuthTypeSchema = z.enum(["pat", "basic"]);

export const CreateConnectionSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    role: ConnectionRoleSchema,
    baseUrl: z.url({ protocol: /^https?$/ }),
    authType: AuthTypeSchema,
    apiToken: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    testBeforeSave: z.boolean().default(true)
  })
  .superRefine((value, context) => {
    if (value.authType === "pat" && !value.apiToken?.trim()) {
      context.addIssue({ code: "custom", path: ["apiToken"], message: "API token is required" });
    }
    if (value.authType === "basic" && (!value.username?.trim() || !value.password)) {
      context.addIssue({ code: "custom", path: ["username"], message: "Username and password are required" });
    }
  });

export type CreateConnectionInput = z.infer<typeof CreateConnectionSchema>;

export const UpdateConnectionSchema = z.object({
  name: z.string().trim().min(2).max(120),
  role: ConnectionRoleSchema,
  baseUrl: z.url({ protocol: /^https?$/ }),
  authType: AuthTypeSchema,
  apiToken: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  isActive: z.boolean().default(true),
  testAfterSave: z.boolean().default(true)
});
export type UpdateConnectionInput = z.infer<typeof UpdateConnectionSchema>;
export type ConnectionRole = z.infer<typeof ConnectionRoleSchema>;
export type AuthType = z.infer<typeof AuthTypeSchema>;

export type CapabilityConfidence = "detected" | "inferred" | "unknown";

export interface Dhis2Capability {
  available: boolean;
  confidence: CapabilityConfidence;
  reason: string;
}

export interface Dhis2Capabilities {
  metadataApi: Dhis2Capability;
  dataValueSetsApi: Dhis2Capability;
  modernTrackerApi: Dhis2Capability;
  legacyTrackerApi: Dhis2Capability;
  enrollmentAnalyticsApi: Dhis2Capability;
  pushAnalyticsApi: Dhis2Capability;
}

export interface ConnectionTestResult {
  healthy: boolean;
  normalizedBaseUrl: string;
  dhis2Version: string | null;
  systemName: string | null;
  currentUser: {
    id?: string;
    username?: string;
    displayName?: string;
  } | null;
  capabilities: Dhis2Capabilities;
  message: string;
  testedAt: string;
}

export interface ConnectionSummary {
  id: string;
  name: string;
  role: ConnectionRole;
  baseUrl: string;
  authType: AuthType;
  dhis2Version: string | null;
  systemName: string | null;
  capabilities: Dhis2Capabilities | Record<string, never>;
  lastTestStatus: "untested" | "healthy" | "failed";
  lastTestMessage: string | null;
  lastTestedAt: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export const ResourceTypeSchema = z.enum(["program", "dataset"]);
export type ResourceType = z.infer<typeof ResourceTypeSchema>;

export interface Dhis2ResourceSummary {
  id: string;
  name: string;
  resourceType: ResourceType;
  description?: string;
  programType?: string;
  periodType?: string;
  stageCount?: number;
  dataElementCount?: number;
}

export const DiscoverMetadataSchema = z.object({
  connectionId: z.uuid(),
  resourceType: ResourceTypeSchema,
  resourceUid: z.string().regex(/^[A-Za-z][A-Za-z0-9]{10}$/, "Invalid DHIS2 UID")
});

export type DiscoverMetadataInput = z.infer<typeof DiscoverMetadataSchema>;

export interface MetadataSnapshotSummary {
  id: string;
  connectionId: string;
  resourceType: ResourceType;
  resourceUid: string;
  resourceName: string;
  dhis2Version: string | null;
  metadataHash: string;
  capturedAt: string;
}

export const FlattenStrategySchema = z.enum([
  "normalized",
  "flattened_latest",
  "flattened_first",
  "flattened_aggregate"
]);
export type FlattenStrategy = z.infer<typeof FlattenStrategySchema>;

export const GenerateBlueprintSchema = DiscoverMetadataSchema.extend({
  strategy: FlattenStrategySchema.default("flattened_latest")
});
export type GenerateBlueprintInput = z.infer<typeof GenerateBlueprintSchema>;

export interface SchemaColumnPreview {
  ordinal: number;
  columnName: string;
  sqlType: string;
  sourceKind: "system" | "attribute" | "data_element" | "category_option_combo" | "derived";
  sourceUid: string | null;
  stageUid: string | null;
  repeatPolicy: string | null;
  nullable: boolean;
  isFilterable: boolean;
  label: string;
  mapping: Record<string, unknown>;
}

export interface SchemaBlueprintSummary {
  id: string;
  snapshotId: string;
  resourceName: string;
  resourceType: ResourceType;
  schemaName: string;
  tableName: string;
  strategy: FlattenStrategy;
  status: "draft" | "approved" | "applied" | "retired";
  version: number;
  generatedBy: "rules" | "ai_assisted" | "manual";
  columns: SchemaColumnPreview[];
  sqlPreview?: string;
  createdAt: string;
  appliedAt: string | null;
}

export const UpdateBlueprintSchema = z.object({
  columns: z.array(z.object({
    columnName: z.string().trim().min(1).max(63),
    label: z.string().trim().min(1).max(240),
    isFilterable: z.boolean()
  })).min(1)
});
export type UpdateBlueprintInput = z.infer<typeof UpdateBlueprintSchema>;

export interface BackupAvailability {
  blueprintId: string;
  years: number[];
}

export const CreateSyncDefinitionSchema = z.object({
  name: z.string().trim().min(2).max(160),
  sourceConnectionId: z.uuid(),
  blueprintId: z.uuid(),
  batchSize: z.number().int().min(1).max(1000).default(250),
  conflictPolicy: z.enum(["source_wins", "destination_wins", "newest_wins", "manual"]).default("source_wins"),
  filters: z.record(z.string(), z.unknown()).default({})
});
export type CreateSyncDefinitionInput = z.infer<typeof CreateSyncDefinitionSchema>;

export const UpdateSyncDefinitionSchema = CreateSyncDefinitionSchema.omit({ filters: true }).extend({
  isActive: z.boolean().default(true)
});
export type UpdateSyncDefinitionInput = z.infer<typeof UpdateSyncDefinitionSchema>;

export const UpsertScheduleSchema = z.object({
  intervalMinutes: z.number().int().min(1).max(525600),
  executionLimit: z.number().int().min(1).nullable().default(null),
  isActive: z.boolean().default(true),
  timezone: z.string().trim().min(1).max(80).default("UTC")
});
export type UpsertScheduleInput = z.infer<typeof UpsertScheduleSchema>;

export interface SyncRunSummary {
  id: string;
  definitionId: string;
  triggerType: "manual" | "scheduled" | "retry";
  status: "queued" | "running" | "succeeded" | "partially_succeeded" | "failed" | "cancelled";
  recordsRead: number;
  recordsWritten: number;
  recordsSkipped: number;
  recordsFailed: number;
  errorSummary: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SyncScheduleSummary {
  id: string;
  intervalMinutes: number;
  timezone: string;
  executionLimit: number | null;
  executionCount: number;
  isActive: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export interface SyncDefinitionSummary {
  id: string;
  name: string;
  sourceConnectionId: string;
  sourceConnectionName: string;
  blueprintId: string;
  resourceType: "tracker" | "aggregate" | "metadata";
  resourceUid: string;
  resourceName: string;
  tableName: string;
  batchSize: number;
  conflictPolicy: string;
  isActive: boolean;
  schedule: SyncScheduleSummary | null;
  latestRun: SyncRunSummary | null;
  createdAt: string;
}

export interface ReportDefinitionSummary {
  blueprintId: string;
  resourceName: string;
  resourceType: ResourceType;
  schemaName: string;
  tableName: string;
  columns: SchemaColumnPreview[];
  rowCount: number;
}

export interface ReportPage {
  columns: SchemaColumnPreview[];
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
}
