import type {
  ConnectionTestResult,
  Dhis2Capabilities,
  Dhis2ResourceSummary
} from "@dhis-sync/contracts";

export type Dhis2Credential =
  | { type: "pat"; apiToken: string }
  | { type: "basic"; username: string; password: string };

export interface Dhis2ClientOptions {
  baseUrl: string;
  credential: Dhis2Credential;
  dhis2Version?: string | null;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

interface SystemInfoResponse {
  version?: string;
  systemName?: string;
  contextPath?: string;
  revision?: string;
}

interface CurrentUserResponse {
  id?: string;
  username?: string;
  displayName?: string;
}

interface ProgramListItem {
  id: string;
  name?: string;
  displayName?: string;
  description?: string;
  programType?: string;
  programStages?: unknown[];
}

interface DataSetListItem {
  id: string;
  name?: string;
  displayName?: string;
  description?: string;
  periodType?: string;
  dataSetElements?: unknown[];
}

export interface TrackerPage {
  instances: Record<string, unknown>[];
  page: number;
  pageSize: number;
  total?: number;
  hasNextPage: boolean;
}

export interface DataValueSetResponse {
  dataSet?: string;
  period?: string;
  orgUnit?: string;
  completeDate?: string;
  dataValues?: Record<string, unknown>[];
  [key: string]: unknown;
}

function assertDhis2Uid(uid: string): void {
  if (!/^[A-Za-z][A-Za-z0-9]{10}$/.test(uid)) {
    throw new Error("Invalid DHIS2 UID");
  }
}

export class Dhis2HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string
  ) {
    super(message);
    this.name = "Dhis2HttpError";
  }
}

export function normalizeDhis2BaseUrl(input: string): string {
  const parsed = new URL(input.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("DHIS2 URL must use HTTP or HTTPS");
  }
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname
    .replace(/\/+$/, "")
    .replace(/\/api(?:\/\d+)?$/i, "")
    .replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

export function parseDhis2Version(version: string | undefined): {
  major: number;
  minor: number;
  patch: number;
} | null {
  if (!version) return null;
  const match = version.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0)
  };
}

export function inferCapabilities(version: string | undefined): Dhis2Capabilities {
  const parsed = parseDhis2Version(version);
  const atLeast = (minor: number) => Boolean(parsed && (parsed.major > 2 || (parsed.major === 2 && parsed.minor >= minor)));
  const versionReason = version ? `Inferred from DHIS2 ${version}` : "DHIS2 version was not returned";

  return {
    metadataApi: { available: true, confidence: "detected", reason: "System information endpoint responded" },
    dataValueSetsApi: { available: true, confidence: "inferred", reason: versionReason },
    modernTrackerApi: { available: atLeast(36), confidence: parsed ? "inferred" : "unknown", reason: versionReason },
    legacyTrackerApi: { available: Boolean(parsed?.major === 2), confidence: parsed ? "inferred" : "unknown", reason: versionReason },
    enrollmentAnalyticsApi: { available: atLeast(40), confidence: parsed ? "inferred" : "unknown", reason: versionReason },
    pushAnalyticsApi: { available: atLeast(35), confidence: parsed ? "inferred" : "unknown", reason: versionReason }
  };
}

export class Dhis2Client {
  readonly baseUrl: string;
  private readonly credential: Dhis2Credential;
  private readonly dhis2Version: string | null;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: Dhis2ClientOptions) {
    this.baseUrl = normalizeDhis2BaseUrl(options.baseUrl);
    this.credential = options.credential;
    this.dhis2Version = options.dhis2Version ?? null;
    // Tracker exports often include nested enrollments and events. Even a
    // moderate page can take longer than a lightweight connection test.
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  private authorizationHeader(): string {
    if (this.credential.type === "pat") {
      return `ApiToken ${this.credential.apiToken}`;
    }
    return `Basic ${Buffer.from(`${this.credential.username}:${this.credential.password}`).toString("base64")}`;
  }

  private async getJson<T>(path: string, timeoutMs = this.timeoutMs): Promise<T> {
    const endpoint = `${this.baseUrl}/api/${path.replace(/^\//, "")}`;
    let response: Response | undefined;
    let networkError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        response = await this.fetchImplementation(endpoint, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: this.authorizationHeader()
          },
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (![429, 502, 503, 504].includes(response.status) || attempt === 3) break;
      } catch (error) {
        networkError = error;
        if (attempt === 3) break;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
    if (!response) {
      const message = networkError instanceof Error ? networkError.message : "Network request failed";
      throw new Error(`Could not reach DHIS2 after 3 attempts: ${message}`);
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      let detail = "";
      try {
        const parsed = JSON.parse(errorBody) as { message?: unknown; errorCode?: unknown; developerMessage?: unknown };
        detail = String(parsed.message ?? parsed.developerMessage ?? parsed.errorCode ?? "").trim();
      } catch {
        detail = errorBody.trim().slice(0, 300);
      }
      if (response.status === 401) {
        throw new Dhis2HttpError(
          "DHIS2 rejected the credentials (HTTP 401). Verify the username and password, or confirm that Basic authentication is enabled on this server",
          response.status,
          path
        );
      }
      if (response.status === 403) {
        throw new Dhis2HttpError(
          "DHIS2 accepted the login but the account is not authorized to use this API (HTTP 403)",
          response.status,
          path
        );
      }
      throw new Dhis2HttpError(
        `DHIS2 returned HTTP ${response.status} for ${path}${detail ? `: ${detail}` : ""}`,
        response.status,
        path
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("json")) {
      throw new Dhis2HttpError(
        "DHIS2 returned a login page instead of API JSON. The credentials may be rejected or API Basic authentication may be disabled",
        response.status,
        path
      );
    }
    return (await response.json()) as T;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const systemInfo = await this.getJson<SystemInfoResponse>("system/info");
    const currentUser = await this.getJson<CurrentUserResponse>(
      "me?fields=id,username,displayName"
    );
    return {
      healthy: true,
      normalizedBaseUrl: this.baseUrl,
      dhis2Version: systemInfo.version ?? null,
      systemName: systemInfo.systemName ?? null,
      currentUser,
      capabilities: inferCapabilities(systemInfo.version),
      message: "Connection and credentials verified",
      testedAt: new Date().toISOString()
    };
  }

  async listPrograms(): Promise<Dhis2ResourceSummary[]> {
    const response = await this.getJson<{ programs?: ProgramListItem[] }>(
      "programs?paging=false&order=displayName:asc&fields=id,name,displayName,description,programType,programStages[id]"
    );
    return (response.programs ?? []).map((program) => ({
      id: program.id,
      name: program.displayName ?? program.name ?? program.id,
      resourceType: "program",
      ...(program.description ? { description: program.description } : {}),
      ...(program.programType ? { programType: program.programType } : {}),
      stageCount: program.programStages?.length ?? 0
    }));
  }

  async listDataSets(): Promise<Dhis2ResourceSummary[]> {
    const response = await this.getJson<{ dataSets?: DataSetListItem[] }>(
      "dataSets?paging=false&order=displayName:asc&fields=id,name,displayName,description,periodType,dataSetElements[id]"
    );
    return (response.dataSets ?? []).map((dataSet) => ({
      id: dataSet.id,
      name: dataSet.displayName ?? dataSet.name ?? dataSet.id,
      resourceType: "dataset",
      ...(dataSet.description ? { description: dataSet.description } : {}),
      ...(dataSet.periodType ? { periodType: dataSet.periodType } : {}),
      dataElementCount: dataSet.dataSetElements?.length ?? 0
    }));
  }

  async getProgram(uid: string): Promise<Record<string, unknown>> {
    assertDhis2Uid(uid);
    return this.getJson<Record<string, unknown>>(
      `programs/${uid}?fields=id,name,displayName,description,programType,version,trackedEntityType[id,displayName],organisationUnits[id,displayName],programTrackedEntityAttributes[mandatory,displayInList,sortOrder,trackedEntityAttribute[id,name,displayName,shortName,valueType,unique,optionSet[id,displayName,options[id,displayName,code]]]],programStages[id,name,displayName,description,repeatable,sortOrder,programStageDataElements[compulsory,displayInReports,sortOrder,dataElement[id,name,displayName,shortName,formName,valueType,optionSet[id,displayName,options[id,displayName,code]]]]]`
    );
  }

  async getDataSet(uid: string): Promise<Record<string, unknown>> {
    assertDhis2Uid(uid);
    return this.getJson<Record<string, unknown>>(
      `dataSets/${uid}?fields=id,name,displayName,description,periodType,version,categoryCombo[id,displayName,categories[id,displayName,categoryOptions[id,displayName,code]]],organisationUnits[id,displayName],dataSetElements[categoryCombo[id,displayName],dataElement[id,name,displayName,shortName,formName,valueType,aggregationType,optionSet[id,displayName,options[id,displayName,code]]]]`
    );
  }

  async getTrackerEntities(programUid: string, page = 1, pageSize = 500, timeoutMs?: number): Promise<TrackerPage> {
    assertDhis2Uid(programUid);
    const safePage = Math.max(1, Math.trunc(page));
    const safePageSize = Math.min(1000, Math.max(1, Math.trunc(pageSize)));
    const fields = "trackedEntity,trackedEntityType,orgUnit,createdAt,updatedAt,attributes[attribute,value,createdAt,updatedAt],enrollments[enrollment,program,orgUnit,enrolledAt,occurredAt,createdAt,updatedAt,status,attributes[attribute,value,createdAt,updatedAt],events[event,programStage,orgUnit,occurredAt,scheduledAt,createdAt,updatedAt,status,dataValues[dataElement,value,createdAt,updatedAt]]";
    const response = await this.getTrackerCollection("tracker/trackedEntities", {
      program: programUid,
      page: String(safePage),
      pageSize: String(safePageSize),
      totalPages: "true",
      fields
    }, timeoutMs);
    const instances = Array.isArray(response.instances)
      ? response.instances as Record<string, unknown>[]
      : Array.isArray(response.trackedEntityInstances)
        ? response.trackedEntityInstances as Record<string, unknown>[]
        : [];
    return this.toTrackerPage(response, instances, safePage, safePageSize);
  }

  async getTrackerEvents(programUid: string, page = 1, pageSize = 500, timeoutMs?: number): Promise<TrackerPage> {
    assertDhis2Uid(programUid);
    const safePage = Math.max(1, Math.trunc(page));
    const safePageSize = Math.min(1000, Math.max(1, Math.trunc(pageSize)));
    const fields = "event,program,programStage,orgUnit,occurredAt,scheduledAt,createdAt,updatedAt,status,dataValues[dataElement,value,createdAt,updatedAt]";
    const response = await this.getTrackerCollection("tracker/events", {
      program: programUid,
      page: String(safePage),
      pageSize: String(safePageSize),
      totalPages: "true",
      fields
    }, timeoutMs);
    const instances = Array.isArray(response.instances)
      ? response.instances as Record<string, unknown>[]
      : Array.isArray(response.events)
        ? response.events as Record<string, unknown>[]
        : [];
    return this.toTrackerPage(response, instances, safePage, safePageSize);
  }

  async getLegacyTrackerEntities(programUid: string, page = 1, pageSize = 500, timeoutMs?: number): Promise<TrackerPage> {
    assertDhis2Uid(programUid);
    const safePage = Math.max(1, Math.trunc(page));
    const safePageSize = Math.min(1000, Math.max(1, Math.trunc(pageSize)));
    const fields = "trackedEntityInstance,trackedEntityType,orgUnit,created,lastUpdated,attributes[attribute,value,created,lastUpdated],enrollments[enrollment,program,orgUnit,enrollmentDate,incidentDate,created,lastUpdated,status,events[event,programStage,orgUnit,eventDate,dueDate,created,lastUpdated,status,dataValues[dataElement,value,created,lastUpdated]]";
    const response = await this.getJson<Record<string, unknown>>(
      `trackedEntityInstances.json?program=${programUid}&ouMode=ALL&page=${safePage}&pageSize=${safePageSize}&totalPages=true&fields=${encodeURIComponent(fields)}`,
      timeoutMs
    );
    const instances = Array.isArray(response.trackedEntityInstances)
      ? response.trackedEntityInstances as Record<string, unknown>[]
      : [];
    return this.toTrackerPage(response, instances, safePage, safePageSize);
  }

  private trackerScopeCandidates(): Array<[string, string]> {
    const version = parseDhis2Version(this.dhis2Version ?? undefined);
    return version && (version.major > 2 || version.minor >= 41)
      ? [["orgUnitMode", "ACCESSIBLE"], ["ouMode", "ALL"]]
      : [["ouMode", "ALL"], ["orgUnitMode", "ACCESSIBLE"]];
  }

  private async getTrackerCollection(
    path: string,
    parameters: Record<string, string>,
    timeoutMs?: number
  ): Promise<Record<string, unknown>> {
    const scopes = this.trackerScopeCandidates();
    let lastError: unknown;
    for (let index = 0; index < scopes.length; index += 1) {
      const [scopeName, scopeValue] = scopes[index]!;
      const query = new URLSearchParams(parameters);
      query.set(scopeName, scopeValue);
      try {
        return await this.getJson<Record<string, unknown>>(`${path}?${query.toString()}`, timeoutMs);
      } catch (error) {
        lastError = error;
        const retryableScopeError = error instanceof Dhis2HttpError
          && [400, 409].includes(error.status)
          && /organi[sz]ation unit|oumode|orgunitmode/i.test(error.message);
        if (!retryableScopeError || index === scopes.length - 1) throw error;
      }
    }
    throw lastError;
  }

  private toTrackerPage(
    response: Record<string, unknown>,
    instances: Record<string, unknown>[],
    requestedPage: number,
    requestedPageSize: number
  ): TrackerPage {
    const nestedPager = response.pager && typeof response.pager === "object"
      ? response.pager as Record<string, unknown>
      : {};
    const numberValue = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;
    // DHIS2 2.40 returns flat paging fields. 2.41+ also returns a pager object.
    const page = numberValue(nestedPager.page) ?? numberValue(response.page) ?? requestedPage;
    const pageSize = numberValue(nestedPager.pageSize) ?? numberValue(response.pageSize) ?? requestedPageSize;
    const pageCount = numberValue(nestedPager.pageCount) ?? numberValue(response.pageCount);
    const total = numberValue(nestedPager.total) ?? numberValue(response.total);
    const hasNextPage = pageCount !== undefined
      ? page < pageCount
      : total !== undefined
        ? page * pageSize < total
        : instances.length === pageSize;
    return {
      instances,
      page,
      pageSize,
      ...(total === undefined ? {} : { total }),
      hasNextPage
    };
  }

  async getDataValueSet(input: {
    dataSetUid: string;
    /** Download every reporting period, overriding any saved date range. */
    allPeriods?: boolean;
    startDate?: string;
    endDate?: string;
    orgUnitUid?: string;
    orgUnitUids?: string[];
    includeChildren?: boolean;
    /** Per-chunk timeout. Aggregate sync can split a timed-out range and retry it. */
    timeoutMs?: number;
  }): Promise<DataValueSetResponse> {
    assertDhis2Uid(input.dataSetUid);
    const orgUnitUids = [...new Set([
      ...(input.orgUnitUid ? [input.orgUnitUid] : []),
      ...(input.orgUnitUids ?? [])
    ])];
    for (const uid of orgUnitUids) assertDhis2Uid(uid);
    if (!orgUnitUids.length) throw new Error("At least one DHIS2 organisation unit is required to export aggregate data");
    const query = new URLSearchParams({
      dataSet: input.dataSetUid,
      children: String(input.includeChildren ?? false)
    });
    const startDate = input.startDate?.trim();
    const endDate = input.endDate?.trim();
    if (input.allPeriods || (!startDate && !endDate)) {
      // DHIS2 requires a time selector. Use a full-history update watermark,
      // not a reporting-period cutoff, so old and currently open periods match.
      query.set("lastUpdated", "0001-01-01");
    } else {
      const validDate = (value: string | undefined): value is string => {
        if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const date = new Date(`${value}T00:00:00.000Z`);
        return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
      };
      if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) {
        throw new Error("Provide valid startDate and endDate (YYYY-MM-DD) in chronological order, or select all periods");
      }
      query.set("startDate", startDate);
      query.set("endDate", endDate);
    }
    for (const uid of orgUnitUids) query.append("orgUnit", uid);
    const timeoutMs = Math.min(180_000, Math.max(5_000, input.timeoutMs ?? this.timeoutMs));
    return this.getJson<DataValueSetResponse>(`dataValueSets?${query.toString()}`, timeoutMs);
  }
}
