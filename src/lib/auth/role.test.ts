import { describe, expect, it } from "vitest";
import type { Queryable } from "../db";
import { ForbiddenError } from "../tenant/context";
import { isJudge, isRole, readRole, requireStaff, ROLES } from "./role";

const SESSION = { sub: "sub-1", email: "x@example.com", tenantId: "00000000-0000-4000-8000-000000000001" };

function fakeQ(rows: unknown[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const q = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return rows;
    },
  } as unknown as Queryable;
  return { q, calls };
}

describe("roles", () => {
  it("knows exactly admin, staff and judge", () => {
    expect([...ROLES]).toEqual(["admin", "staff", "judge"]);
    expect(isRole("judge")).toBe(true);
    expect(isRole("owner")).toBe(false);
    expect(isRole(undefined)).toBe(false);
    expect(isJudge("judge")).toBe(true);
    expect(isJudge("staff")).toBe(false);
  });

  it("reads the subject's one role in the transaction's tenant", async () => {
    const { q, calls } = fakeQ([{ role: "staff" }]);
    await expect(readRole(q, SESSION)).resolves.toBe("staff");
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("tenant_id = current_tenant_id()");
    expect(calls[0].params).toEqual(["sub-1"]);
  });

  it("refuses no row, two rows, an unknown role and an empty subject (fail closed)", async () => {
    for (const rows of [[], [{ role: "staff" }, { role: "admin" }], [{ role: "owner" }], [{ role: null }]]) {
      const err = await readRole(fakeQ(rows).q, SESSION).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).reason).toBe("membership");
    }
    const { q, calls } = fakeQ([{ role: "admin" }]);
    await expect(readRole(q, { ...SESSION, sub: "" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(calls).toHaveLength(0);
  });

  it("requireStaff lets admin and staff through and refuses a judge with the judge reason", async () => {
    await expect(requireStaff(fakeQ([{ role: "admin" }]).q, SESSION)).resolves.toBe("admin");
    await expect(requireStaff(fakeQ([{ role: "staff" }]).q, SESSION)).resolves.toBe("staff");
    const err = await requireStaff(fakeQ([{ role: "judge" }]).q, SESSION).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).reason).toBe("judge");
  });
});
