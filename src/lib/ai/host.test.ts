import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostFor } from "./host";
import { AiError } from "./types";

const META = "https://api.meta.ai/v1/responses";
const BASETEN = "https://inference.baseten.co/v1/chat/completions";
const ARN = "arn:aws:rds:us-east-2:000000000000:cluster:example";

let logged: string[];

beforeEach(() => {
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function refused(fn: () => unknown): AiError {
  try {
    fn();
  } catch (err) {
    if (err instanceof AiError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("hostFor", () => {
  it("leaves every provider URL alone when no override is set", () => {
    expect(hostFor(META, { NODE_ENV: "development" })).toBe(META);
    expect(hostFor(META, { NODE_ENV: "production", DB_CLUSTER_ARN: ARN })).toBe(META);
    expect(hostFor(BASETEN, { NODE_ENV: "development", AI_HOST_OVERRIDE: "" })).toBe(BASETEN);
    expect(logged).toEqual([]);
  });

  it("in local mode, swaps only the origin for the loopback replay host", () => {
    const env = { NODE_ENV: "development", AI_HOST_OVERRIDE: "http://127.0.0.1:4010" };
    expect(hostFor(META, env)).toBe("http://127.0.0.1:4010/v1/responses");
    expect(hostFor(BASETEN, env)).toBe("http://127.0.0.1:4010/v1/chat/completions");
    expect(hostFor("https://api.meta.ai/v1/x?a=1", { ...env, AI_HOST_OVERRIDE: "http://localhost:9/" })).toBe(
      "http://localhost:9/v1/x?a=1",
    );
    expect(logged).toEqual([]);
  });

  it("is inert in production: an override there refuses every call, with one line and no value", () => {
    const err = refused(() =>
      hostFor(META, { NODE_ENV: "production", AI_HOST_OVERRIDE: "http://127.0.0.1:4010" }),
    );
    expect(err.category).toBe("not_configured");
    expect(logged).toHaveLength(1);
    expect(logged[0]).not.toContain("127.0.0.1");
  });

  it("is inert with an Aurora cluster configured, even outside a production build", () => {
    for (const NODE_ENV of ["development", "test"]) {
      const err = refused(() =>
        hostFor(META, { NODE_ENV, DB_CLUSTER_ARN: ARN, AI_HOST_OVERRIDE: "http://127.0.0.1:4010" }),
      );
      expect(err.category).toBe("not_configured");
    }
    expect(logged).toHaveLength(2);
  });

  it("refuses an override that is not a bare loopback origin", () => {
    for (const bad of [
      "https://example.com",
      "http://10.0.0.5:4010",
      "http://127.0.0.1.example.com",
      "http://127.0.0.1:4010/v1",
      "http://user:pw@127.0.0.1:4010",
      "file:///tmp/x",
      "not a url",
    ]) {
      const err = refused(() => hostFor(META, { NODE_ENV: "development", AI_HOST_OVERRIDE: bad }));
      expect(err.category, bad).toBe("not_configured");
    }
    expect(logged.every((l) => !l.includes("example.com"))).toBe(true);
  });
});
