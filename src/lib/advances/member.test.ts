import { describe, expect, it } from "vitest";
import type { Queryable } from "../db";
import { ForbiddenError } from "../tenant/context";
import { readMember } from "./member";

const SESSION = { sub: "sub-1", email: "x@example.com", tenantId: "00000000-0000-4000-8000-000000000001" };
const MEMBER_ID = "00000000-0000-4000-8000-0000000000aa";

// The membership check answers one row; the member read answers the given role.
function fakeQ(role: unknown) {
  return {
    query: async (sql: string) => {
      if (sql.startsWith("SELECT 1 AS ok FROM memberships")) return [{ ok: 1 }];
      if (sql.startsWith("SELECT id, role FROM memberships")) return [{ id: MEMBER_ID, role }];
      throw new Error(`unexpected statement: ${sql}`);
    },
  } as unknown as Queryable;
}

describe("readMember", () => {
  it("names an admin or a staff member with their role", async () => {
    await expect(readMember(fakeQ("admin"), SESSION)).resolves.toEqual({ id: MEMBER_ID, role: "admin" });
    await expect(readMember(fakeQ("staff"), SESSION)).resolves.toEqual({ id: MEMBER_ID, role: "staff" });
  });

  it("refuses a demo visitor (the judge role) and any role it does not know", async () => {
    for (const role of ["judge", "owner", null, ""]) {
      const err = await readMember(fakeQ(role), SESSION).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).reason).toBe("membership");
    }
  });
});
