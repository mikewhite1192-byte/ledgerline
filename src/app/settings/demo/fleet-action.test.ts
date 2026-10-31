import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import { DbError } from "@/lib/db";
import { moveFleetAction } from "./fleet-action";

// Move the fleet runs only with the demo page's switch on, and a database failure comes back as a
// category: a lost COMMIT reply is unknown (the moves may have landed), never "nothing changed".

const mocks = vi.hoisted(() => ({
  withRequestTenant: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/tenant/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/context")>()),
  withRequestTenant: mocks.withRequestTenant,
}));

const saved = flags.demoResetEnabled;

beforeEach(() => {
  flags.demoResetEnabled = true;
  mocks.withRequestTenant.mockResolvedValue({ pickedUp: 2, delivered: 1 });
});

afterEach(() => {
  flags.demoResetEnabled = saved;
  vi.clearAllMocks();
});

describe("moveFleetAction", () => {
  it("moves the fleet with the switch on", async () => {
    expect(await moveFleetAction()).toEqual({ ok: true, pickedUp: 2, delivered: 1 });
    expect(mocks.withRequestTenant).toHaveBeenCalledTimes(1);
  });

  it("reads nothing while the demo page's switch is off", async () => {
    flags.demoResetEnabled = false;
    expect(await moveFleetAction()).toEqual({ ok: false, category: "disabled" });
    expect(mocks.withRequestTenant).not.toHaveBeenCalled();
  });

  it("says unknown for a lost COMMIT reply, and keeps the other failures apart", async () => {
    mocks.withRequestTenant.mockRejectedValueOnce(new DbError("unknown"));
    expect(await moveFleetAction()).toEqual({ ok: false, category: "unknown" });
    mocks.withRequestTenant.mockRejectedValueOnce(new DbError("timeout"));
    expect(await moveFleetAction()).toEqual({ ok: false, category: "unreadable" });
    mocks.withRequestTenant.mockRejectedValueOnce(new DbError("sql", "23514"));
    expect(await moveFleetAction()).toEqual({ ok: false, category: "failed" });
  });
});
