import { describe, expect, it, vi } from "vitest";
import { secretStep } from "./secret-step";

// A made-up value that stands in for the deployed password.
const SECRET = ["not", "a", "real", "password", "7Qx"].join("-");

// What a failed fill looks like: the value in the call log, and again in a cause.
function failedFill(): Error {
  return new Error(`locator.fill: Error: Element is not an <input>\nCall log:\n  - fill("${SECRET}")`, {
    cause: new Error(`fill("${SECRET}")`),
  });
}

function everythingIn(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return [String(err), err.stack ?? "", JSON.stringify(err, Object.getOwnPropertyNames(err))].join("\n");
}

describe("secretStep", () => {
  it("on the deployed target, throws only the fixed message, with no cause", async () => {
    const leave = vi.fn(async () => undefined);
    const thrown = await secretStep({ deployed: true, message: "password fill failed", leave }, async () => {
      throw failedFill();
    }).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("password fill failed");
    expect((thrown as Error).cause).toBeUndefined();
    expect(everythingIn(thrown)).not.toContain(SECRET);
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it("leaves the page before the error is thrown", async () => {
    const order: string[] = [];
    const leave = vi.fn(async () => {
      order.push("leave");
    });
    await secretStep({ deployed: true, message: "sign in failed", leave }, async () => {
      order.push("run");
      throw failedFill();
    }).catch(() => order.push("thrown"));
    expect(order).toEqual(["run", "leave", "thrown"]);
  });

  it("still throws the fixed message when leaving the page fails", async () => {
    const leave = vi.fn(async () => {
      throw new Error(`page.goto failed after fill("${SECRET}")`);
    });
    const thrown = await secretStep({ deployed: true, message: "password fill failed", leave }, async () => {
      throw failedFill();
    }).catch((err: unknown) => err);
    expect((thrown as Error).message).toBe("password fill failed");
    expect(everythingIn(thrown)).not.toContain(SECRET);
  });

  it("drops a thrown value that is not an Error too", async () => {
    const thrown = await secretStep(
      { deployed: true, message: "password fill failed", leave: async () => undefined },
      async () => {
        throw `fill("${SECRET}")`;
      },
    ).catch((err: unknown) => err);
    expect((thrown as Error).message).toBe("password fill failed");
    expect(everythingIn(thrown)).not.toContain(SECRET);
  });

  it("locally rethrows the original error and stays on the page", async () => {
    const original = failedFill();
    const leave = vi.fn(async () => undefined);
    const thrown = await secretStep({ deployed: false, message: "password fill failed", leave }, async () => {
      throw original;
    }).catch((err: unknown) => err);
    expect(thrown).toBe(original);
    expect(leave).not.toHaveBeenCalled();
  });

  it("returns what the step returns and leaves nothing when it passes", async () => {
    for (const deployed of [true, false]) {
      const leave = vi.fn(async () => undefined);
      await expect(secretStep({ deployed, message: "unused", leave }, async () => 42)).resolves.toBe(42);
      expect(leave).not.toHaveBeenCalled();
    }
  });
});
