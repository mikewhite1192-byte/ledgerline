import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DbError } from "@/lib/db";
import { createPgDb } from "@/lib/db/pg";
import { adminUrl, appUrl } from "@/lib/db/test-urls";
import type { Db, Queryable } from "@/lib/db/types";
import { loaded } from "./loaded";
import { readTodayIntake } from "./today";

// The Today card's intake counts against a real database, as the app's role: it counts what came
// in on the carrier's own day (Chicago here, so the day runs 06:00 to 06:00 UTC in November),
// the whole 25 hours of the day the clocks fall back, never another carrier's rows, and a carrier
// whose day cannot be placed reads as unavailable, never as zero. Four tenants, removed after.

const A = randomUUID();
const B = randomUUID();
const BROKEN = randomUUID();
const FALL_BACK = randomUUID();
const TODAY = "2026-11-02";

let admin: Db;
let app: Db;

async function tenant(id: string, timezone: string): Promise<void> {
  await admin.withTenant(id, (q) =>
    q.execute("INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, $3)", [
      `home-today-${id.slice(0, 8)}`,
      `Carrier ${id.slice(0, 8)}`,
      timezone,
    ]),
  );
}

async function documentAt(q: Queryable, at: string): Promise<void> {
  await q.execute(
    `INSERT INTO documents (id, tenant_id, uploaded_by, filename, mime, byte_length, bytes, content_hash,
       trace_id, created_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), 'ops', 'receipt.pdf', 'application/pdf', 1,
       decode('00', 'hex'), $2, CAST($3 AS uuid), CAST($4 AS timestamptz))`,
    [randomUUID(), createHash("sha256").update(randomUUID()).digest("hex"), randomUUID(), at],
  );
}

async function voiceNoteAt(q: Queryable, at: string): Promise<void> {
  await q.execute(
    `INSERT INTO voice_notes (id, tenant_id, trace_id, created_by, status, created_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'ops', 'transcribed', CAST($3 AS timestamptz))`,
    [randomUUID(), randomUUID(), at],
  );
}

async function messageAt(q: Queryable, at: string): Promise<void> {
  await q.execute(
    `INSERT INTO inbound_messages (id, tenant_id, channel, received_at, status, created_by, trace_id)
     VALUES (CAST($1 AS uuid), current_tenant_id(), 'paste', CAST($2 AS timestamptz), 'received', 'ops',
       CAST($3 AS uuid))`,
    [randomUUID(), at, randomUUID()],
  );
}

const intakeOf = (id: string) => app.withTenant(id, (q) => readTodayIntake(q, TODAY));

describe("Home's intake counts for today", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    await tenant(A, "America/Chicago");
    await tenant(B, "America/New_York");
    await tenant(BROKEN, "Nowhere/Zone");
    await tenant(FALL_BACK, "America/Chicago");
    await admin.withTenant(A, async (q) => {
      // Inside Nov 2 in Chicago: just after its midnight and just before the next.
      await documentAt(q, "2026-11-02T06:30:00Z");
      await documentAt(q, "2026-11-03T05:30:00Z");
      // Outside it: Nov 1 at 11:30 PM and Nov 3 at 12:30 AM, Chicago time.
      await documentAt(q, "2026-11-02T05:30:00Z");
      await documentAt(q, "2026-11-03T06:30:00Z");
      await voiceNoteAt(q, "2026-11-02T15:00:00Z");
      await voiceNoteAt(q, "2026-11-01T15:00:00Z");
      // A message counts on the day it was received, whenever its row was written.
      await messageAt(q, "2026-11-02T20:00:00Z");
      await messageAt(q, "2026-10-30T20:00:00Z");
    });
    await admin.withTenant(B, async (q) => {
      await documentAt(q, "2026-11-02T15:00:00Z");
      await documentAt(q, "2026-11-02T16:00:00Z");
      await documentAt(q, "2026-11-02T17:00:00Z");
      await voiceNoteAt(q, "2026-11-02T15:00:00Z");
      await messageAt(q, "2026-11-02T15:00:00Z");
      await messageAt(q, "2026-11-02T16:00:00Z");
    });
    // Nov 1, 2026 in Chicago runs 25 hours: 12:30 AM is still daylight time (UTC-5), 11:30 PM is
    // standard time (UTC-6), and Nov 2 starts at 06:00 UTC.
    await admin.withTenant(FALL_BACK, async (q) => {
      await documentAt(q, "2026-11-01T05:30:00Z");
      await documentAt(q, "2026-11-02T05:30:00Z");
      await documentAt(q, "2026-11-02T06:30:00Z");
    });
  });

  afterAll(async () => {
    for (const id of [A, B, BROKEN, FALL_BACK]) {
      await admin?.withTenant(id, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    }
    await app?.close();
    await admin?.close();
  });

  it("counts only what came in on the carrier's own day", async () => {
    expect(await intakeOf(A)).toEqual({ documents: 2, voiceNotes: 1, messages: 1 });
  });

  it("never counts another carrier's rows", async () => {
    expect(await intakeOf(B)).toEqual({ documents: 3, voiceNotes: 1, messages: 2 });
  });

  it("counts the whole of the day the clocks fall back, 12:30 AM to 11:30 PM, and not the next day's first hour", async () => {
    const day = (date: string) => app.withTenant(FALL_BACK, (q) => readTodayIntake(q, date));
    expect(await day("2026-11-01")).toEqual({ documents: 2, voiceNotes: 0, messages: 0 });
    expect(await day("2026-11-02")).toEqual({ documents: 1, voiceNotes: 0, messages: 0 });
  });

  it("reads a quiet day as zeros, not as a failure", async () => {
    expect(await app.withTenant(A, (q) => readTodayIntake(q, "2026-10-15"))).toEqual({
      documents: 0,
      voiceNotes: 0,
      messages: 0,
    });
  });

  it("reads a failed read as unavailable, never as zero", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The database refuses a time zone it does not know.
      await expect(intakeOf(BROKEN)).rejects.toBeInstanceOf(DbError);
      expect(await loaded("intake", () => intakeOf(BROKEN))).toEqual({ ok: false });
      // A carrier with no row of its own cannot place its day either.
      expect(await loaded("intake", () => intakeOf(randomUUID()))).toEqual({ ok: false });
    } finally {
      log.mockRestore();
    }
  });
});
