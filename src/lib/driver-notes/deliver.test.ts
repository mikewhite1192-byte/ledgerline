import { afterEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import type { Queryable, TenantDb } from "../db";
import { deliverNoteEmail, isAllowlisted, type EmailMessage } from "./deliver";

describe("isAllowlisted", () => {
  it("matches whole addresses only, ignoring case and spaces", () => {
    expect(isAllowlisted("Drv-1@Carrier.example", [" drv-1@carrier.example "])).toBe(true);
    expect(isAllowlisted("drv-1@carrier.example", [])).toBe(false);
    expect(isAllowlisted("drv-1@carrier.example", ["carrier.example"])).toBe(false);
    expect(isAllowlisted("drv-1@carrier.example", ["drv-1@carrier.example.evil"])).toBe(false);
    expect(isAllowlisted("  ", [""])).toBe(false);
  });
});

describe("deliverNoteEmail", () => {
  const saved = { ...flags, driverNotesEmailAllowlist: [...flags.driverNotesEmailAllowlist] };
  afterEach(() => {
    Object.assign(flags, saved, { driverNotesEmailAllowlist: [...saved.driverNotesEmailAllowlist] });
  });

  const SESSION = { sub: "sub-1", email: "", tenantId: "00000000-0000-4000-8000-0000000000cc" };
  const NOTE_ID = "00000000-0000-4000-8000-0000000000dd";
  const ADDRESS = "drv-1@carrier.example";

  // A database that answers the membership check and the note read, and records every other
  // statement it is sent: an approved note on the driver view, with the period dates given.
  function fakeDb(period: { start: string; end: string }) {
    const other: string[] = [];
    const q: Queryable = {
      async query<T>(sql: string): Promise<T[]> {
        if (sql.includes("FROM memberships")) return [{ ok: 1 }] as T[];
        if (sql.includes("FROM driver_notes n")) {
          return [
            {
              status: "approved",
              channel: "driver_view",
              body: "Hola, su pago neto es $1,000.00.",
              cited_seqs: "[]",
              settlement_id: "00000000-0000-4000-8000-0000000000ee",
              email: ADDRESS,
              period_start: period.start,
              period_end: period.end,
              language: "es",
            },
          ] as T[];
        }
        other.push(sql);
        return [];
      },
      async execute(sql: string): Promise<number> {
        other.push(sql);
        return 1;
      },
    };
    const db: TenantDb = { withTenant: (_tenantId, fn) => fn(q) };
    return { db, other };
  }

  function armEmail() {
    flags.driverNotesEnabled = true;
    flags.driverNotesEmailEnabled = true;
    flags.driverNotesEmailAllowlist = [ADDRESS];
  }

  it("sends nothing while notes as a whole are off, even with email armed", async () => {
    armEmail();
    flags.driverNotesEnabled = false;
    const { db, other } = fakeDb({ start: "2026-10-26", end: "2026-11-01" });
    const sent: EmailMessage[] = [];
    const lines: string[] = [];
    const result = await deliverNoteEmail(SESSION, NOTE_ID, {
      db,
      log: (l) => lines.push(l),
      send: async (m) => {
        sent.push(m);
      },
    });
    expect(result).toEqual({ sent: false, category: "disabled" });
    expect(lines).toEqual([`would send note ${NOTE_ID} (disabled)`]);
    expect(sent).toEqual([]);
    expect(other).toEqual([]);
  });

  it("works out the message before the reservation, so a date it cannot read leaves the note unreserved", async () => {
    armEmail();
    // The period's words refuse an end before the start. The database never holds one (its check
    // keeps every period seven days long), so only a fake can show it.
    const { db, other } = fakeDb({ start: "2026-11-01", end: "2026-10-26" });
    const sent: EmailMessage[] = [];
    await expect(
      deliverNoteEmail(SESSION, NOTE_ID, {
        db,
        log: () => undefined,
        send: async (m) => {
          sent.push(m);
        },
      }),
    ).rejects.toThrow(RangeError);
    // No settlement read, no reservation, no send.
    expect(other).toEqual([]);
    expect(sent).toEqual([]);
  });
});
