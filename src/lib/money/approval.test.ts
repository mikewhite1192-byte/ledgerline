import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import type { Param, Queryable } from "../db";
import { ForbiddenError } from "../tenant/context";
import { approvalFrom } from "./approval";
import { dbLedgerStore } from "./execute";

const TENANT = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";
const SESSION = { sub: "person-1", email: "", tenantId: TENANT };

function fakeQ(rows: Record<string, unknown>[]) {
  const seen: { sql: string; params?: Param[] }[] = [];
  const q: Queryable = {
    async query<T>(sql: string, params?: Param[]) {
      seen.push({ sql, params });
      return rows as T[];
    },
    async execute() {
      throw new Error("approval never writes");
    },
  };
  return { q, seen };
}

describe("approvalFrom", () => {
  it("returns the one membership of the session's subject in the current tenant", async () => {
    const { q, seen } = fakeQ([{ id: MEMBER, role: "staff", current: TENANT }]);
    const a = await approvalFrom(q, SESSION);
    expect(a).toEqual({ membershipId: MEMBER, role: "staff", sub: "person-1" });
    expect(seen).toHaveLength(1);
    expect(seen[0].sql).toContain("tenant_id = current_tenant_id()");
    expect(seen[0].params).toEqual(["person-1"]);
  });

  it("compares the tenant whole, case aside", async () => {
    const { q } = fakeQ([{ id: MEMBER, role: "admin", current: TENANT }]);
    await expect(approvalFrom(q, { ...SESSION, tenantId: TENANT.toUpperCase() })).resolves.toEqual(
      expect.objectContaining({ role: "admin" }),
    );
    const other = fakeQ([{ id: MEMBER, role: "admin", current: TENANT.replace(/1$/, "2") }]);
    await expect(approvalFrom(other.q, SESSION)).rejects.toThrow(ForbiddenError);
  });

  it("refuses no row, two rows, an unknown role and a bad id", async () => {
    const cases = [
      [],
      [
        { id: MEMBER, role: "staff", current: TENANT },
        { id: MEMBER, role: "staff", current: TENANT },
      ],
      [{ id: MEMBER, role: "viewer", current: TENANT }],
      [{ id: "2222-not-a-uuid", role: "staff", current: TENANT }],
    ];
    for (const rows of cases) {
      await expect(approvalFrom(fakeQ(rows).q, SESSION)).rejects.toThrow(ForbiddenError);
    }
  });

  it("refuses a session without a subject before any query", async () => {
    const { q, seen } = fakeQ([{ id: MEMBER, role: "staff", current: TENANT }]);
    await expect(approvalFrom(q, { ...SESSION, sub: "" })).rejects.toThrow(ForbiddenError);
    expect(seen).toHaveLength(0);
  });
});

// The money backstop for the judge role (migration 0043): whatever route a demo visitor reaches,
// nothing pays without an Approval, and only approvalFrom makes one, for admin or staff only.
describe("a judge and the Approval", () => {
  it("a judge never gets an Approval", async () => {
    const { q } = fakeQ([{ id: MEMBER, role: "judge", current: TENANT }]);
    const err = await approvalFrom(q, SESSION).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
  });

  const ROOT = resolve(__dirname, "../../..");
  const files = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) files(full, out);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(full);
    }
    return out;
  };
  const source = files(join(ROOT, "src")).map((f) => ({
    file: relative(ROOT, f).split(sep).join("/"),
    text: readFileSync(f, "utf8"),
  }));

  it("only approvalFrom builds an Approval outside the test fakes, and no app code imports the fakes", () => {
    const builders = source.filter((s) => /as Approval\b|<Approval>/.test(s.text)).map((s) => s.file);
    expect(builders.sort()).toEqual(["src/lib/money/approval.ts", "src/lib/money/test-fakes.ts"]);
    const fakeUsers = source.filter((s) => /from "[^"]*test-fakes"/.test(s.text)).map((s) => s.file);
    expect(fakeUsers).toEqual([]);
  });

  it("every path that needs an Approval gets it from approvalFrom", () => {
    const callers = source.filter((s) => /\bapprovalFrom\(/.test(s.text) && s.file !== "src/lib/money/approval.ts");
    expect(callers.map((s) => s.file).sort()).toEqual([
      "src/lib/money/execute.ts",
      "src/lib/money/reconcile.ts",
      "src/lib/settlements/batch.ts",
    ]);
    // The executor and the reconcile pass reach it through the ledger store, which is approvalFrom.
    expect(dbLedgerStore.approvalFrom).toBe(approvalFrom);
  });
});
