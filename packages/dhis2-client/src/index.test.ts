import { describe, expect, it, vi } from "vitest";
import { Dhis2Client, inferCapabilities, normalizeDhis2BaseUrl } from "./index.js";

describe("normalizeDhis2BaseUrl", () => {
  it("removes API and version suffixes", () => {
    expect(normalizeDhis2BaseUrl("https://play.dhis2.org/40.2.0/api/40/"))
      .toBe("https://play.dhis2.org/40.2.0");
  });

  it("preserves a DHIS2 context path", () => {
    expect(normalizeDhis2BaseUrl("https://example.org/national/api/"))
      .toBe("https://example.org/national");
  });
});

describe("inferCapabilities", () => {
  it("enables the modern tracker API for supported releases", () => {
    expect(inferCapabilities("2.41.3").modernTrackerApi.available).toBe(true);
    expect(inferCapabilities("2.35").modernTrackerApi.available).toBe(false);
  });
});

describe("Dhis2Client", () => {
  it("tests system info and the current user without exposing credentials", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: "2.41.1", systemName: "Demo" }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "abc", username: "admin" }), { status: 200, headers: { "content-type": "application/json" } }));

    const client = new Dhis2Client({
      baseUrl: "https://example.org/dhis/api",
      credential: { type: "pat", apiToken: "secret" },
      fetchImplementation: fetchMock
    });
    const result = await client.testConnection();

    expect(result.healthy).toBe(true);
    expect(result.dhis2Version).toBe("2.41.1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "ApiToken secret" });
  });

  it("returns a clear message when DHIS2 rejects credentials", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 401 })
    );
    const client = new Dhis2Client({
      baseUrl: "https://example.org/dhis",
      credential: { type: "basic", username: "user", password: "wrong" },
      fetchImplementation: fetchMock
    });

    await expect(client.testConnection()).rejects.toThrow("DHIS2 rejected the credentials");
  });

  it("exports aggregate data for multiple organisation units", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ dataValues: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const client = new Dhis2Client({
      baseUrl: "https://example.org/dhis",
      credential: { type: "pat", apiToken: "secret" },
      fetchImplementation: fetchMock
    });

    await client.getDataValueSet({
      dataSetUid: "j5Gj5Trw7PS",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      orgUnitUids: ["DiszpKrYNg8", "YuQRtpLP10I"]
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.getAll("orgUnit")).toEqual(["DiszpKrYNg8", "YuQRtpLP10I"]);
    expect(url.searchParams.get("children")).toBe("false");
    expect(url.searchParams.get("startDate")).toBe("2026-01-01");
    expect(url.searchParams.get("endDate")).toBe("2026-01-31");
    expect(url.searchParams.has("lastUpdated")).toBe(false);
  });

  it.each([
    {},
    { allPeriods: true, startDate: "2025-01-01", endDate: "2026-12-31" }
  ])("exports all reporting periods without a rolling cutoff: %j", async (timeFilter) => {
    const historicalValues = [
      { period: "199901", value: "7" },
      { period: "201001", value: "8" },
      { period: "2026", value: "9" }
    ];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ dataValues: historicalValues }), {
        status: 200, headers: { "content-type": "application/json" }
      })
    );
    const client = new Dhis2Client({
      baseUrl: "https://example.org/dhis",
      credential: { type: "pat", apiToken: "secret" },
      fetchImplementation: fetchMock
    });

    const result = await client.getDataValueSet({
      dataSetUid: "j5Gj5Trw7PS", orgUnitUid: "DiszpKrYNg8", ...timeFilter
    });

    const query = new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams;
    expect(query.get("lastUpdated")).toBe("0001-01-01");
    for (const key of ["startDate", "endDate", "period", "lastUpdatedDuration", "limit"]) {
      expect(query.has(key)).toBe(false);
    }
    expect(result.dataValues).toEqual(historicalValues);
  });

  it.each([
    { startDate: "2020-01-01" },
    { endDate: "2026-12-31" },
    { startDate: "2026-12-31", endDate: "2020-01-01" },
    { startDate: "2026-02-30", endDate: "2026-12-31" }
  ])("rejects an incomplete or invalid explicit range: %j", async (timeFilter) => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new Dhis2Client({
      baseUrl: "https://example.org/dhis",
      credential: { type: "pat", apiToken: "secret" },
      fetchImplementation: fetchMock
    });

    await expect(client.getDataValueSet({
      dataSetUid: "j5Gj5Trw7PS", orgUnitUid: "DiszpKrYNg8", ...timeFilter
    })).rejects.toThrow("Provide valid startDate and endDate");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the DHIS2 2.40 tracker scope parameter and reads flat pagination", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        instances: [{ trackedEntity: "te123456789" }],
        page: 1,
        pageSize: 1,
        total: 2,
        pageCount: 2
      }), { status: 200, headers: { "content-type": "application/json" } })
    );
    const client = new Dhis2Client({
      baseUrl: "https://example.org/dhis",
      credential: { type: "pat", apiToken: "secret" },
      dhis2Version: "2.40.12",
      fetchImplementation: fetchMock
    });

    const result = await client.getTrackerEntities("IpHINAT79UW", 1, 1);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("ouMode")).toBe("ALL");
    expect(url.searchParams.has("orgUnitMode")).toBe(false);
    expect(result).toMatchObject({ page: 1, pageSize: 1, total: 2, hasNextPage: true });
  });

  it("uses the renamed DHIS2 2.41 tracker scope parameter and nested pager", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        instances: [],
        pager: { page: 2, pageSize: 50, total: 50, pageCount: 1 }
      }), { status: 200, headers: { "content-type": "application/json" } })
    );
    const client = new Dhis2Client({
      baseUrl: "https://example.org/dhis",
      credential: { type: "pat", apiToken: "secret" },
      dhis2Version: "2.41.3",
      fetchImplementation: fetchMock
    });

    const result = await client.getTrackerEntities("IpHINAT79UW", 2, 50);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("orgUnitMode")).toBe("ACCESSIBLE");
    expect(result.hasNextPage).toBe(false);
  });

  it("retries a 409 caused by an incompatible organisation-unit parameter", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "At least one organisation unit must be specified" }), {
        status: 409,
        headers: { "content-type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ instances: [], page: 1, pageSize: 50 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    const client = new Dhis2Client({
      baseUrl: "https://example.org/dhis",
      credential: { type: "pat", apiToken: "secret" },
      dhis2Version: "2.40.12",
      fetchImplementation: fetchMock
    });

    await client.getTrackerEntities("IpHINAT79UW", 1, 50);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(retryUrl.searchParams.get("orgUnitMode")).toBe("ACCESSIBLE");
  });

  it("downloads event-program records from the tracker events endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ instances: [{ event: "event123456" }], page: 1, pageSize: 250 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const client = new Dhis2Client({
      baseUrl: "https://example.org/dhis",
      credential: { type: "pat", apiToken: "secret" },
      dhis2Version: "2.40.12",
      fetchImplementation: fetchMock
    });

    const result = await client.getTrackerEvents("bMcwwoVnbSR", 1, 250);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/tracker/events?");
    expect(result.instances).toHaveLength(1);
  });
});
