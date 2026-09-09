import type {
  FlattenStrategy,
  ResourceType,
  SchemaColumnPreview
} from "@dhis-sync/contracts";

type JsonRecord = Record<string, unknown>;

const TYPE_MAP: Record<string, string> = {
  INTEGER: "integer",
  INTEGER_POSITIVE: "integer",
  INTEGER_NEGATIVE: "integer",
  INTEGER_ZERO_OR_POSITIVE: "integer",
  NUMBER: "numeric",
  PERCENTAGE: "numeric",
  UNIT_INTERVAL: "numeric",
  BOOLEAN: "boolean",
  TRUE_ONLY: "boolean",
  DATE: "date",
  DATETIME: "timestamptz",
  TIME: "time",
  LONG_TEXT: "text",
  FILE_RESOURCE: "text",
  IMAGE: "text",
  ORGANISATION_UNIT: "varchar(20)",
  TRACKER_ASSOCIATE: "varchar(20)",
  USERNAME: "varchar(255)",
  EMAIL: "varchar(320)",
  PHONE_NUMBER: "varchar(80)",
  URL: "text"
};

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function array(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function firstNonBlank(values: unknown[], fallback = ""): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

export function sqlTypeForValueType(valueType: unknown): string {
  return TYPE_MAP[string(valueType).toUpperCase()] ?? "text";
}

export function safeIdentifier(value: string, fallback = "field"): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[0-9]/, "f_$&") || fallback;
  return normalized.slice(0, 55).replace(/_+$/g, "") || fallback;
}

function uniqueColumnName(base: string, uid: string, used: Set<string>): string {
  let candidate = safeIdentifier(base, `field_${uid.toLowerCase()}`);
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  candidate = `${candidate.slice(0, 46)}_${uid.toLowerCase().slice(-8)}`;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${candidate.slice(0, 51)}_${suffix++}`;
  }
  used.add(candidate);
  return candidate;
}

function optionMapping(item: JsonRecord): Record<string, unknown> {
  const optionSet = record(item.optionSet);
  const optionSetId = string(optionSet.id);
  if (!optionSetId) return {};
  const optionValues = array(optionSet.options).map((option) => ({
    code: firstNonBlank([option.code, option.id]),
    name: firstNonBlank([option.displayName, option.name, option.code, option.id])
  })).filter((option) => option.code);
  return {
    optionSetId,
    optionSetName: string(optionSet.displayName ?? optionSet.name),
    optionCount: optionValues.length,
    optionValues
  };
}

function appendDisplayColumn(
  columns: SchemaColumnPreview[],
  used: Set<string>,
  sourceColumn: SchemaColumnPreview,
  label: string,
  uid: string
): void {
  if (!sourceColumn.mapping.optionSetId) return;
  const displayColumnName = uniqueColumnName(`${sourceColumn.columnName}_name`, uid, used);
  sourceColumn.label = `${label} (code)`;
  sourceColumn.mapping = { ...sourceColumn.mapping, valueRole: "code", displayColumnName };
  columns.push({
    ordinal: columns.length + 1,
    columnName: displayColumnName,
    sqlType: "text",
    sourceKind: "derived",
    sourceUid: uid,
    stageUid: sourceColumn.stageUid,
    repeatPolicy: sourceColumn.repeatPolicy,
    // Display labels are derived enrichment. Keep them nullable so an existing
    // applied table can be upgraded even when a historical code is unknown.
    nullable: true,
    isFilterable: sourceColumn.isFilterable,
    label,
    mapping: {
      valueRole: "display",
      codeColumnName: sourceColumn.columnName,
      optionSetId: sourceColumn.mapping.optionSetId,
      optionSetName: sourceColumn.mapping.optionSetName
    }
  });
}

function semanticHints(label: string): Record<string, unknown> {
  const normalized = label.toLowerCase();
  const hints: string[] = [];
  if (/patient|client|case/.test(normalized) && /id|number|code/.test(normalized)) hints.push("patient_identifier");
  if (/facility|hospital|clinic|organi[sz]ation unit/.test(normalized)) hints.push("facility");
  if (/date|time/.test(normalized)) hints.push("temporal");
  if (/district|upazila|region|division/.test(normalized)) hints.push("geography");
  return hints.length ? { semanticHints: hints } : {};
}

function systemColumns(resourceType: ResourceType, metadata: JsonRecord): SchemaColumnPreview[] {
  const common: Omit<SchemaColumnPreview, "ordinal">[] = [
    { columnName: "record_id", sqlType: "uuid", sourceKind: "system", sourceUid: null, stageUid: null, repeatPolicy: null, nullable: false, isFilterable: false, label: "Record ID", mapping: { primaryKey: true, default: "gen_random_uuid()" } },
    { columnName: "org_unit_uid", sqlType: "varchar(20)", sourceKind: "system", sourceUid: null, stageUid: null, repeatPolicy: null, nullable: false, isFilterable: true, label: "Facility UID", mapping: {} },
    { columnName: "org_unit_name", sqlType: "text", sourceKind: "system", sourceUid: null, stageUid: null, repeatPolicy: null, nullable: true, isFilterable: true, label: "Facility", mapping: { semanticHints: ["facility"] } }
  ];
  const isEventProgram = resourceType === "program" && metadata.programType === "WITHOUT_REGISTRATION";
  const specific: Omit<SchemaColumnPreview, "ordinal">[] = resourceType === "program"
    ? isEventProgram
      ? [
        { columnName: "event_uid", sqlType: "varchar(20)", sourceKind: "system", sourceUid: null, stageUid: null, repeatPolicy: null, nullable: false, isFilterable: true, label: "Event UID", mapping: {} },
        { columnName: "event_date", sqlType: "date", sourceKind: "system", sourceUid: null, stageUid: null, repeatPolicy: null, nullable: true, isFilterable: true, label: "Event Date", mapping: { semanticHints: ["temporal"] } }
      ]
      : [
        { columnName: "tracked_entity_uid", sqlType: "varchar(20)", sourceKind: "system", sourceUid: null, stageUid: null, repeatPolicy: null, nullable: true, isFilterable: true, label: "Tracked Entity UID", mapping: {} },
        { columnName: "enrollment_uid", sqlType: "varchar(20)", sourceKind: "system", sourceUid: null, stageUid: null, repeatPolicy: null, nullable: true, isFilterable: true, label: "Enrollment UID", mapping: {} },
        { columnName: "enrollment_date", sqlType: "date", sourceKind: "system", sourceUid: null, stageUid: null, repeatPolicy: null, nullable: true, isFilterable: true, label: "Enrollment Date", mapping: { semanticHints: ["temporal"] } },
        { columnName: "incident_date", sqlType: "date", sourceKind: "system", sourceUid: null, stageUid: null, repeatPolicy: null, nullable: true, isFilterable: true, label: "Incident Date", mapping: { semanticHints: ["temporal"] } }
      ]
    : [
        { columnName: "period", sqlType: "varchar(32)", sourceKind: "system", sourceUid: null, stageUid: null, repeatPolicy: null, nullable: false, isFilterable: true, label: "Period", mapping: { semanticHints: ["temporal"] } },
        { columnName: "category_option_combo_uid", sqlType: "varchar(20)", sourceKind: "system", sourceUid: null, stageUid: null, repeatPolicy: null, nullable: true, isFilterable: true, label: "Category Option Combo UID", mapping: {} },
        { columnName: "attribute_option_combo_uid", sqlType: "varchar(20)", sourceKind: "system", sourceUid: null, stageUid: null, repeatPolicy: null, nullable: true, isFilterable: true, label: "Attribute Option Combo UID", mapping: {} }
      ];
  const tail: Omit<SchemaColumnPreview, "ordinal">[] = [
    { columnName: "source_last_updated_at", sqlType: "timestamptz", sourceKind: "system", sourceUid: null, stageUid: null, repeatPolicy: null, nullable: true, isFilterable: true, label: "Source Last Updated", mapping: {} },
    { columnName: "sync_run_id", sqlType: "uuid", sourceKind: "system", sourceUid: null, stageUid: null, repeatPolicy: null, nullable: true, isFilterable: false, label: "Sync Run ID", mapping: {} },
    { columnName: "raw_payload", sqlType: "jsonb", sourceKind: "system", sourceUid: null, stageUid: null, repeatPolicy: null, nullable: false, isFilterable: false, label: "Raw DHIS2 Payload", mapping: { default: "{}" } }
  ];
  return [...common, ...specific, ...tail].map((column, index) => ({ ...column, ordinal: index + 1 }));
}

export function generateColumns(
  resourceType: ResourceType,
  metadata: JsonRecord,
  strategy: FlattenStrategy
): SchemaColumnPreview[] {
  const columns = systemColumns(resourceType, metadata);
  const used = new Set(columns.map((column) => column.columnName));

  if (resourceType === "program") {
    for (const programAttribute of array(metadata.programTrackedEntityAttributes)) {
      const attribute = record(programAttribute.trackedEntityAttribute);
      const uid = string(attribute.id);
      if (!uid) continue;
      const label = firstNonBlank([attribute.displayName, attribute.name, attribute.formName, attribute.shortName], uid);
      const sourceColumn: SchemaColumnPreview = {
        ordinal: columns.length + 1,
        columnName: uniqueColumnName(label, uid, used),
        sqlType: sqlTypeForValueType(attribute.valueType),
        sourceKind: "attribute",
        sourceUid: uid,
        stageUid: null,
        repeatPolicy: null,
        nullable: programAttribute.mandatory !== true,
        isFilterable: programAttribute.displayInList === true || Object.keys(semanticHints(label)).length > 0,
        label,
        mapping: { ...optionMapping(attribute), ...semanticHints(label) }
      };
      columns.push(sourceColumn);
      appendDisplayColumn(columns, used, sourceColumn, label, uid);
    }
    for (const stage of array(metadata.programStages)) {
      const stageUid = string(stage.id);
      const stageLabel = firstNonBlank([stage.displayName, stage.name], stageUid);
      const repeatPolicy = stage.repeatable === true
        ? strategy.replace("flattened_", "")
        : "single";
      for (const stageElement of array(stage.programStageDataElements)) {
        const dataElement = record(stageElement.dataElement);
        const uid = string(dataElement.id);
        if (!uid) continue;
        const label = firstNonBlank([dataElement.displayName, dataElement.name, dataElement.formName, dataElement.shortName], uid);
        const baseName = `${safeIdentifier(stageLabel, "stage")}__${safeIdentifier(label, uid)}`;
        const sourceColumn: SchemaColumnPreview = {
          ordinal: columns.length + 1,
          columnName: uniqueColumnName(baseName, uid, used),
          sqlType: sqlTypeForValueType(dataElement.valueType),
          sourceKind: "data_element",
          sourceUid: uid,
          stageUid,
          repeatPolicy,
          nullable: stageElement.compulsory !== true,
          isFilterable: stageElement.displayInReports === true || Object.keys(semanticHints(label)).length > 0,
          label: `${stageLabel}: ${label}`,
          mapping: { ...optionMapping(dataElement), ...semanticHints(label), stageLabel }
        };
        columns.push(sourceColumn);
        appendDisplayColumn(columns, used, sourceColumn, `${stageLabel}: ${label}`, uid);
      }
    }
  } else {
    for (const dataSetElement of array(metadata.dataSetElements)) {
      const dataElement = record(dataSetElement.dataElement);
      const uid = string(dataElement.id);
      if (!uid) continue;
      const label = firstNonBlank([dataElement.displayName, dataElement.name, dataElement.formName, dataElement.shortName], uid);
      const sourceColumn: SchemaColumnPreview = {
        ordinal: columns.length + 1,
        columnName: uniqueColumnName(label, uid, used),
        sqlType: sqlTypeForValueType(dataElement.valueType),
        sourceKind: "data_element",
        sourceUid: uid,
        stageUid: null,
        repeatPolicy: "aggregate_value",
        nullable: true,
        isFilterable: Object.keys(semanticHints(label)).length > 0,
        label,
        mapping: { ...optionMapping(dataElement), ...semanticHints(label), aggregationType: dataElement.aggregationType }
      };
      columns.push(sourceColumn);
      appendDisplayColumn(columns, used, sourceColumn, label, uid);
    }
  }
  return columns;
}

export function tableNameFor(resourceName: string, uid: string): string {
  return `dhis_${safeIdentifier(resourceName, "resource").slice(0, 42)}_${uid.toLowerCase().slice(-6)}`;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}

export function createTableSql(schemaName: string, tableName: string, columns: SchemaColumnPreview[]): string {
  const definitions = columns.map((column) => {
    const mapping = column.mapping;
    const primaryKey = mapping.primaryKey === true ? " PRIMARY KEY" : "";
    const defaultValue = mapping.default === "gen_random_uuid()"
      ? " DEFAULT gen_random_uuid()"
      : column.columnName === "raw_payload"
        ? " DEFAULT '{}'::jsonb"
        : "";
    const nullable = column.nullable || primaryKey ? "" : " NOT NULL";
    return `  ${quoteIdentifier(column.columnName)} ${column.sqlType}${defaultValue}${nullable}${primaryKey}`;
  });
  return `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schemaName)};\n\nCREATE TABLE IF NOT EXISTS ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)} (\n${definitions.join(",\n")}\n);`;
}

export function reconcileTableColumnsSql(
  schemaName: string,
  tableName: string,
  columns: SchemaColumnPreview[]
): string[] {
  const qualifiedTable = `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
  return columns.map((column) => {
    const defaultValue = column.mapping.default === "gen_random_uuid()"
      ? " DEFAULT gen_random_uuid()"
      : column.columnName === "raw_payload"
        ? " DEFAULT '{}'::jsonb"
        : "";
    return `ALTER TABLE ${qualifiedTable} ADD COLUMN IF NOT EXISTS ${quoteIdentifier(column.columnName)} ${column.sqlType}${defaultValue}`;
  });
}
