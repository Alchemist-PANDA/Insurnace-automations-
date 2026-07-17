import { describe, it, expect, beforeEach } from "vitest";
import { loadEnv, resetEnvCache } from "./index.js";

const base = {
  DATABASE_URL: "postgres://stl:stl@localhost:5432/stl",
  REDIS_URL: "redis://localhost:6379",
  AUTH_SECRET: "sixteen-chars-min-secret",
  CREDENTIAL_ENCRYPTION_KEY: "somebase64key==",
};

describe("loadEnv", () => {
  beforeEach(() => resetEnvCache());

  it("applies defaults for optional values", () => {
    const env = loadEnv({ ...base } as NodeJS.ProcessEnv);
    expect(env.NODE_ENV).toBe("development");
    expect(env.API_PORT).toBe(4000);
    expect(env.USE_FAKE_ADAPTERS).toBe(true);
  });

  it("throws a readable aggregate error when required vars are missing", () => {
    expect(() => loadEnv({} as NodeJS.ProcessEnv)).toThrow(
      /Invalid environment configuration/,
    );
  });

  it("coerces numeric ports", () => {
    const env = loadEnv({ ...base, API_PORT: "5555" } as NodeJS.ProcessEnv);
    expect(env.API_PORT).toBe(5555);
  });

  it("parses USE_FAKE_ADAPTERS as boolean", () => {
    const env = loadEnv({
      ...base,
      USE_FAKE_ADAPTERS: "false",
    } as NodeJS.ProcessEnv);
    expect(env.USE_FAKE_ADAPTERS).toBe(false);
  });
});
