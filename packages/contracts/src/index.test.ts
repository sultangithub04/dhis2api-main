import { describe, expect, it } from "vitest";
import { CreateConnectionSchema } from "./index.js";

const common = {
  name: "Training server",
  role: "source" as const,
  baseUrl: "https://example.org/dhis",
  testBeforeSave: true
};

describe("CreateConnectionSchema", () => {
  it("ignores an empty token when basic authentication is selected", () => {
    const result = CreateConnectionSchema.safeParse({
      ...common,
      authType: "basic",
      username: "admin",
      password: "secret",
      apiToken: ""
    });
    expect(result.success).toBe(true);
  });

  it("ignores empty basic fields when token authentication is selected", () => {
    const result = CreateConnectionSchema.safeParse({
      ...common,
      authType: "pat",
      apiToken: "token",
      username: "",
      password: ""
    });
    expect(result.success).toBe(true);
  });

  it("requires credentials for the selected authentication method", () => {
    const result = CreateConnectionSchema.safeParse({
      ...common,
      authType: "basic",
      username: "",
      password: ""
    });
    expect(result.success).toBe(false);
  });
});
