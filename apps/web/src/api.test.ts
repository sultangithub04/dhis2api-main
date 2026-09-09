import { afterEach, describe, expect, it, vi } from "vitest";
import { schemaApi, syncApi } from "./api.js";

function jsonResponse() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

describe("API request headers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not send a JSON content type for a bodyless action", async () => {
    const fetchMock = vi.fn(async () => jsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    await schemaApi.apply("282c9fd4-9776-4cd7-9d06-5b57b7881bd2");

    const call = fetchMock.mock.calls.at(0) as unknown as [unknown, RequestInit];
    const init = call[1];
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect((init.headers as Headers).has("Content-Type")).toBe(false);
  });

  it("keeps the JSON content type when a request has a JSON body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    await schemaApi.generate({
      connectionId: "f71d0418-8106-4ed8-ae64-c49501d47e2d",
      resourceType: "program",
      resourceUid: "Vu0q0uaHxXX",
      strategy: "flattened_latest"
    });

    const call = fetchMock.mock.calls.at(0) as unknown as [unknown, RequestInit];
    const init = call[1];
    expect(init.method).toBe("POST");
    expect(init.body).toBeTypeOf("string");
    expect((init.headers as Headers).get("Content-Type")).toBe("application/json");
  });

  it("turns a browser network failure into an actionable API error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));

    await expect(syncApi.delete("sync-id", "Temporary sync"))
      .rejects.toThrow("Cannot reach the local API at");
  });
});
