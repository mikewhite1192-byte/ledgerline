import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { DbError, type Param, type Queryable } from "@/lib/db";
import { addNoteAction, editNoteAction, keepNoteAction, removeNoteAction } from "./actions";

// The Memory page's writes: each checks the switch before anything else, checks what the browser
// sent, runs inside the carrier's own membership-checked transaction, and answers with a category
// only. Nothing is written while the switch is off.

const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};
const NOTE = "33333333-3333-4333-8333-333333333333";
const CUSTOMER = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  getDb: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getDb: mocks.getDb,
}));

type Carrier = { member?: boolean; found?: boolean; failing?: boolean };

function carrier({ member = true, found = true, failing = false }: Carrier = {}) {
  const writes: { sql: string; params: Param[] }[] = [];
  const q: Queryable = {
    async query<T>(sql: string, params: Param[] = []): Promise<T[]> {
      if (failing) throw new DbError("unavailable");
      if (sql.includes("FROM memberships")) return (member ? [{ ok: 1 }] : []) as T[];
      if (sql.startsWith("SELECT 1 AS ok FROM customers")) return (found ? [{ ok: 1 }] : []) as T[];
      if (sql.includes("pg_advisory_xact_lock")) return [{ ok: 1 }] as T[];
      if (sql.includes("count(*)")) return [{ n: "4" }] as T[];
      if (/^(INSERT|UPDATE|DELETE)/.test(sql)) {
        writes.push({ sql, params });
        return (found ? [{ id: NOTE }] : []) as T[];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async execute() {
      throw new Error("the store writes through query");
    },
  };
  mocks.getDb.mockReturnValue({
    withTenant: async <T,>(tenantId: string, fn: (q: Queryable) => Promise<T>) => {
      expect(tenantId).toBe(SESSION.tenantId);
      return fn(q);
    },
  });
  return writes;
}

const saved = flags.carrierMemoryEnabled;
beforeEach(() => {
  mocks.requireSession.mockResolvedValue(SESSION);
  flags.carrierMemoryEnabled = true;
});
afterEach(() => {
  flags.carrierMemoryEnabled = saved;
  vi.clearAllMocks();
});

describe("the Memory page's actions", () => {
  it("refuse every write while the switch is off, before a session or a transaction", async () => {
    flags.carrierMemoryEnabled = false;
    const off = { ok: false, category: "off" };
    expect(await addNoteAction("carrier", "Bill weekly")).toEqual(off);
    expect(await editNoteAction(NOTE, "Bill weekly")).toEqual(off);
    expect(await keepNoteAction(NOTE)).toEqual(off);
    expect(await removeNoteAction(NOTE)).toEqual(off);
    expect(mocks.requireSession).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("add a note about a customer as the signed-in person, and refresh the page", async () => {
    const writes = carrier();
    expect(await addNoteAction(`customer:${CUSTOMER}`, "Calls ahead")).toEqual({ ok: true });
    expect(writes).toHaveLength(1);
    expect(writes[0].sql).toMatch(/^INSERT INTO carrier_notes/);
    expect(writes[0].params.slice(0, 4)).toEqual(["customer", CUSTOMER, "Calls ahead", SESSION.sub]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/memory");
  });

  it("add a note about the whole carrier", async () => {
    const writes = carrier();
    expect(await addNoteAction("carrier", "Bill detention the same week")).toEqual({ ok: true });
    expect(writes[0].params.slice(0, 2)).toEqual(["carrier", null]);
  });

  it("refuse what the browser sent when it is not a note, before a transaction", async () => {
    const bad: [unknown, unknown][] = [
      ["customer", "Calls ahead"],
      [`customer:${CUSTOMER}:x`, "Calls ahead"],
      [`loads:${CUSTOMER}`, "Calls ahead"],
      [`customer:not-an-id`, "Calls ahead"],
      [null, "Calls ahead"],
      ["carrier", 42],
    ];
    for (const [subject, text] of bad) expect(await addNoteAction(subject, text)).toEqual({ ok: false, category: "invalid" });
    for (const id of [undefined, "", "nope", `${NOTE} OR 1=1`]) {
      expect(await editNoteAction(id, "Calls ahead")).toEqual({ ok: false, category: "invalid" });
      expect(await keepNoteAction(id)).toEqual({ ok: false, category: "invalid" });
      expect(await removeNoteAction(id)).toEqual({ ok: false, category: "invalid" });
    }
    expect(await editNoteAction(NOTE, null)).toEqual({ ok: false, category: "invalid" });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("refuse a web address in the words, writing nothing", async () => {
    const writes = carrier();
    expect(await addNoteAction("carrier", "See https://example.test")).toEqual({ ok: false, category: "invalid" });
    expect(writes).toEqual([]);
  });

  it("report a customer that is not this carrier's", async () => {
    const writes = carrier({ found: false });
    expect(await addNoteAction(`customer:${CUSTOMER}`, "Calls ahead")).toEqual({ ok: false, category: "subject_not_found" });
    expect(writes).toEqual([]);
  });

  it("edit, keep and remove a note of this carrier", async () => {
    const writes = carrier();
    expect(await editNoteAction(NOTE, "Calls ahead on Fridays")).toEqual({ ok: true });
    expect(await keepNoteAction(NOTE)).toEqual({ ok: true });
    expect(await removeNoteAction(NOTE)).toEqual({ ok: true });
    expect(writes.map((w) => w.sql.split(" ")[0])).toEqual(["UPDATE", "UPDATE", "DELETE"]);
    expect(writes[1].sql).toContain("status = 'suggested'");
  });

  it("report a note that is not here as not found", async () => {
    carrier({ found: false });
    expect(await editNoteAction(NOTE, "Calls ahead")).toEqual({ ok: false, category: "not_found" });
    expect(await keepNoteAction(NOTE)).toEqual({ ok: false, category: "not_found" });
    expect(await removeNoteAction(NOTE)).toEqual({ ok: false, category: "not_found" });
  });

  it("refuse a login with no membership, writing nothing", async () => {
    const writes = carrier({ member: false });
    expect(await addNoteAction("carrier", "Bill weekly")).toEqual({ ok: false, category: "forbidden" });
    expect(await removeNoteAction(NOTE)).toEqual({ ok: false, category: "forbidden" });
    expect(writes).toEqual([]);
  });

  it("report a database failure as a category and still refresh the page", async () => {
    carrier({ failing: true });
    expect(await removeNoteAction(NOTE)).toEqual({ ok: false, category: "unreadable" });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/memory");
  });
});
