import type {
  BackupAvailability,
  ConnectionSummary,
  ConnectionTestResult,
  CreateConnectionInput,
  CreateSyncDefinitionInput,
  Dhis2ResourceSummary,
  GenerateBlueprintInput,
  ReportDefinitionSummary,
  ReportPage,
  ResourceType,
  SchemaBlueprintSummary,
  SyncDefinitionSummary,
  UpdateBlueprintInput,
  UpdateConnectionInput,
  UpdateSyncDefinitionInput,
  UpsertScheduleInput
} from "@dhis-sync/contracts";

export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000/api/v1";

function connectionPayload(input: CreateConnectionInput): CreateConnectionInput {
  const common = {
    name: input.name,
    role: input.role,
    baseUrl: input.baseUrl,
    authType: input.authType,
    testBeforeSave: input.testBeforeSave
  };
  return input.authType === "pat"
    ? { ...common, authType: "pat", apiToken: input.apiToken }
    : { ...common, authType: "basic", username: input.username, password: input.password };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("Content-Type") && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers
    });
  } catch (cause) {
    if (cause instanceof TypeError) {
      throw new Error(`Cannot reach the local API at ${API_URL}. Make sure the API server is running, then try again.`);
    }
    throw cause;
  }
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const candidate = payload as { message?: string | string[] } | null;
    const message = Array.isArray(candidate?.message)
      ? candidate.message.join(", ")
      : candidate?.message ?? `Request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

async function download(path: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`);
  } catch (cause) {
    if (cause instanceof TypeError) throw new Error(`Cannot reach the local API at ${API_URL}. Make sure the API server is running, then try again.`);
    throw cause;
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string | string[] } | null;
    const message = Array.isArray(payload?.message) ? payload.message.join(", ") : payload?.message;
    throw new Error(message ?? `Download failed with HTTP ${response.status}`);
  }
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? "dhis2-backup";
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  return filename;
}

export const connectionApi = {
  list: () => request<ConnectionSummary[]>("/connections"),
  test: (input: CreateConnectionInput) => request<ConnectionTestResult>("/connections/test", {
    method: "POST",
    body: JSON.stringify(connectionPayload(input))
  }),
  create: (input: CreateConnectionInput) => request<ConnectionSummary>("/connections", {
    method: "POST",
    body: JSON.stringify(connectionPayload(input))
  }),
  update: (id: string, input: UpdateConnectionInput) => request<ConnectionSummary>(`/connections/${id}`, {
    method: "PUT", body: JSON.stringify(input)
  }),
  testSaved: (id: string) => request<ConnectionSummary>(`/connections/${id}/test`, { method: "POST" }),
  delete: (id: string, name: string) => request<{ deleted: true }>(`/connections/${id}?confirm=${encodeURIComponent(name)}`, { method: "DELETE" })
};

export const schemaApi = {
  resources: (connectionId: string, type: ResourceType) =>
    request<Dhis2ResourceSummary[]>(`/metadata/connections/${connectionId}/resources?type=${type}`),
  list: () => request<SchemaBlueprintSummary[]>("/schema-blueprints"),
  generate: (input: GenerateBlueprintInput) => request<SchemaBlueprintSummary>("/schema-blueprints", {
    method: "POST", body: JSON.stringify(input)
  }),
  update: (id: string, input: UpdateBlueprintInput) => request<SchemaBlueprintSummary>(`/schema-blueprints/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  apply: (id: string) => request<SchemaBlueprintSummary>(`/schema-blueprints/${id}/apply`, { method: "POST" }),
  drop: (id: string, tableName: string, cascade = false) => request<{ dropped: true; deletedSyncDefinitions: number }>(`/schema-blueprints/${id}/table?confirm=${encodeURIComponent(tableName)}&cascade=${cascade}`, { method: "DELETE" }),
  deleteBlueprint: (id: string, tableName: string) => request<{ deleted: true }>(`/schema-blueprints/${id}/blueprint?confirm=${encodeURIComponent(tableName)}`, { method: "DELETE" })
};

export const syncApi = {
  list: () => request<SyncDefinitionSummary[]>("/sync-definitions"),
  create: (input: CreateSyncDefinitionInput) => request<SyncDefinitionSummary>("/sync-definitions", { method: "POST", body: JSON.stringify(input) }),
  update: (id: string, input: UpdateSyncDefinitionInput) => request<SyncDefinitionSummary>(`/sync-definitions/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  run: (id: string) => request<SyncDefinitionSummary>(`/sync-definitions/${id}/run`, { method: "POST" }),
  schedule: (id: string, input: UpsertScheduleInput) => request<SyncDefinitionSummary>(`/sync-definitions/${id}/schedule`, { method: "PUT", body: JSON.stringify(input) }),
  deleteSchedule: (id: string) => request<{ deleted: true }>(`/sync-definitions/${id}/schedule`, { method: "DELETE" }),
  clearRuns: (id: string) => request<{ deleted: number }>(`/sync-definitions/${id}/runs`, { method: "DELETE" }),
  delete: (id: string, name: string) => request<{ deleted: true }>(`/sync-definitions/${id}?confirm=${encodeURIComponent(name)}`, { method: "DELETE" })
};

export const reportApi = {
  list: () => request<ReportDefinitionSummary[]>("/reports"),
  data: (id: string, parameters: URLSearchParams) => request<ReportPage>(`/reports/${id}/data?${parameters.toString()}`),
  csvUrl: (id: string, parameters: URLSearchParams) => `${API_URL}/reports/${id}/export.csv?${parameters.toString()}`
};

export const backupApi = {
  years: (id: string) => request<BackupAvailability>(`/backups/${id}/years`),
  download: (id: string, format: "json" | "csv", year: string) =>
    download(`/backups/${id}/data.${format}?year=${encodeURIComponent(year || "all")}`)
};
