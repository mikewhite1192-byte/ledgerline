import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { tmsSource } from "../adapters/tms-source";
import {
  TmsSourceError,
  type ListBookmark,
  type TmsConnection,
  type TmsContext,
  type TmsDocumentRow,
  type TmsHistoryRow,
  type TmsLineItem,
  type TmsListRow,
  type TmsLoadRecord,
  type TmsPartyRecord,
  type TmsSource,
} from "../adapters/tms-source/types";
import type { Session } from "../auth/claims";
import { DbError, type Queryable, type TenantDb } from "../db";
import { tmsGoneCard } from "../loads/movement";
import { assertMembership } from "../tenant/context";
import { parseInstant } from "../time/local-date";
import { isUuid } from "../uuid";
import {
  documentColumnsOf,
  eventColumnsOf,
  lineColumnsOf,
  loadColumnsOf,
  MIRROR_FLAGS,
  type MirrorFlag,
} from "./mirror";
import { isFinalized, readLabelMap, type TmsStatusCode } from "./status";
import { attemptedWakeUp, markWakeUp, waitingWakeUps } from "./wakeups";

// TMS-MIRROR (0075): the sync. A step at the top of the desk loop's discovery (and Settings >
// Demo's Sync dispatch now), run by the holder of the desk loop's lease. It walks the TMS list
// newest created first from a (createdAt, id) bookmark kept in desk_loops.watermarks.tms_walk,
// at most maxPagesPerWake pages and maxReadsPerWake full reads a wake, and nothing more once the
// caller's deadline comes (the page stays unfinished, the walk is saved). A list row only picks a
// candidate: every write comes from a full read by id (the record, every history page until an
// empty one, documents, line items, unseen drivers), each read in its own short transaction and
// never inside the write. Then ONE transaction per load writes the mirror. A read that throws
// leaves the mirror as it was and bumps read_attempts; at 10 the load rests (flag read_failed)
// until its updatedAt moves. A read that finds the load gone writes a tombstone (gone_at), never
// a retry, and one card when our linked load still runs. When the list ends, every mirrored load
// the pass did not list is read by id, then the pass is complete and the next starts at the top.
// Nothing here writes to the TMS, moves a load or moves money: a mirrored status event is the
// desk's tms_event source (src/lib/loads/movement.ts moveFromTmsEvent).

export const MAX_ATTEMPTS = 10;
// History pages one read may take before the load reads as malformed.
export const MAX_HISTORY_PAGES = 20;
// Unmirrored loads whose reads threw, kept in the walk state (oldest dropped past this).
export const MAX_MISSES = 200;

export type PullResult =
  | { ran: false; category: "switched_off" | "not_configured" | "no_lease" }
  | {
      ran: true;
      listed: number;
      read: number;
      written: number;
      gone: number;
      failed: number;
      passComplete: boolean;
      // The list itself failed this wake: the category, never the cause.
      listFailed: string | null;
      // "deadline": the run's deadline came first. The page it was on stays unfinished (the
      // bookmark does not move), the walk is saved, and the next pass resumes there.
      stopped: "deadline" | null;
    };

// clock: epoch ms, read against run.deadlineMs (Date.now unless a test or the desk passes its own).
export type PullDeps = { source?: TmsSource; newId?: () => string; clock?: () => number };

type Miss = { n: number; u: string };
type Walk = { passStartedAt: string; below: ListBookmark | null; misses: Record<string, Miss> };

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// How long a wake-up for a party whose read keeps failing stays waiting (TMS-MIRROR T4).
export const PARTY_RETRY_MS = 60 * 60_000;
const isIso = (v: unknown): v is string => typeof v === "string" && ISO_MS.test(v);
const ms = (v: string) => parseInstant(v);
const iso = (v: string) => new Date(parseInstant(v)).toISOString();
const ts = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// The stored walk, read strictly: anything else starts a new pass now (the mirror's unique keys
// make a walk read twice write nothing new).
export function readWalk(value: unknown, nowIso: string): Walk {
  const fresh: Walk = { passStartedAt: nowIso, below: null, misses: {} };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fresh;
  const v = value as Record<string, unknown>;
  if (!isIso(v.passStartedAt)) return fresh;
  let below: ListBookmark | null = null;
  if (v.below !== null && v.below !== undefined) {
    const b = v.below as Record<string, unknown>;
    if (typeof b !== "object" || !isIso(b.createdAt) || typeof b.id !== "string" || b.id.length === 0 || b.id.length > 64) {
      return fresh;
    }
    below = { createdAt: b.createdAt, id: b.id };
  }
  const misses: Record<string, Miss> = {};
  if (typeof v.misses === "object" && v.misses !== null && !Array.isArray(v.misses)) {
    for (const [id, m] of Object.entries(v.misses as Record<string, unknown>).slice(-MAX_MISSES)) {
      const x = m as Record<string, unknown>;
      if (id.length > 0 && id.length <= 64 && typeof x === "object" && x !== null && Number.isSafeInteger(x.n) && isIso(x.u)) {
        misses[id] = { n: Math.min(Number(x.n), MAX_ATTEMPTS), u: x.u as string };
      }
    }
  }
  return { passStartedAt: v.passStartedAt, below, misses };
}

type ConnectionRow = {
  id: string;
  system: string;
  label_map: string;
  lookback_hours: number;
  finalize_cooloff_minutes: number;
  feed_floor_at: string | null;
  zone: string;
  walk: string | null;
  held: number;
};

const CONNECTION_SQL = `SELECT CAST(c.id AS text) AS id, c.system, CAST(c.label_map AS text) AS label_map,
       CAST(c.lookback_hours AS integer) AS lookback_hours,
       CAST(c.finalize_cooloff_minutes AS integer) AS finalize_cooloff_minutes,
       ${ts("c.feed_floor_at")} AS feed_floor_at,
       (SELECT t.timezone FROM tenants t WHERE t.id = current_tenant_id()) AS zone,
       (SELECT CAST(l.watermarks->'tms_walk' AS text) FROM desk_loops l
         WHERE l.tenant_id = current_tenant_id() AND l.lease_token = CAST($1 AS uuid)) AS walk,
       (SELECT CAST(count(*) AS integer) FROM desk_loops l
         WHERE l.tenant_id = current_tenant_id() AND l.lease_token = CAST($1 AS uuid)
           AND l.lease_until > CAST($2 AS timestamptz)) AS held
  FROM tms_connections c WHERE c.tenant_id = current_tenant_id()`;

// Only the lease holder moves the walk; a lost lease throws and the wake writes nothing more.
const SAVE_WALK_SQL = `UPDATE desk_loops
    SET watermarks = watermarks || jsonb_build_object('tms_walk', CAST($1 AS jsonb)),
        updated_at = CAST($2 AS timestamptz)
  WHERE tenant_id = current_tenant_id() AND lease_token = CAST($3 AS uuid)`;

// The fence on every other write: each write transaction first locks the lease row by this run's
// token. FOR SHARE is enough: a reclaim (CLAIM_LEASE_SQL, or the desk's own claim) is an UPDATE of
// that row, which conflicts with a share lock, so a reclaim waits for a write already under way, and
// a write after a reclaim finds no row and rolls back. The run's own writes are one after another, so
// nothing stronger is needed. The token is the check, never a clock: a stale holder's clock is stale.
const HOLD_LEASE_SQL = `SELECT 1 AS held FROM desk_loops
  WHERE tenant_id = current_tenant_id() AND lease_token = CAST($1 AS uuid) FOR SHARE`;

type MirrorState = {
  id: string;
  external_id: string;
  load_id: string | null;
  source_updated_at: string;
  read_attempts: number;
  rest_updated_at: string | null;
  recheck_after: string | null;
  finalized_seen_at: string | null;
  gone: boolean;
  flags: string;
};

const STATE_COLUMNS = `CAST(id AS text) AS id, external_id, CAST(load_id AS text) AS load_id,
       ${ts("source_updated_at")} AS source_updated_at, CAST(read_attempts AS integer) AS read_attempts,
       ${ts("rest_updated_at")} AS rest_updated_at, ${ts("recheck_after")} AS recheck_after,
       ${ts("finalized_seen_at")} AS finalized_seen_at, (gone_at IS NOT NULL) AS gone, CAST(flags AS text) AS flags`;

function flagsOf(text: string | null): MirrorFlag[] {
  if (text === null) return [];
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? (v.filter((f) => (MIRROR_FLAGS as readonly unknown[]).includes(f)) as MirrorFlag[]) : [];
  } catch {
    return [];
  }
}

const uniq = (list: readonly MirrorFlag[]): MirrorFlag[] => MIRROR_FLAGS.filter((f) => list.includes(f));

// Whether a listed row is a candidate for a full read.
export function isCandidate(row: TmsListRow, state: MirrorState | undefined, miss: Miss | undefined, nowIso: string): boolean {
  if (!state) return !miss || miss.n < MAX_ATTEMPTS || ms(row.updatedAt) > ms(miss.u);
  if (state.gone) return false;
  if (state.read_attempts >= MAX_ATTEMPTS) return state.rest_updated_at === null || ms(row.updatedAt) > ms(state.rest_updated_at);
  if (state.read_attempts > 0) return true;
  if (ms(row.updatedAt) > ms(state.source_updated_at)) return true;
  return state.recheck_after !== null && ms(state.recheck_after) <= ms(nowIso);
}

type FullRead =
  | { kind: "gone" }
  | {
      kind: "ok";
      record: TmsLoadRecord;
      history: TmsHistoryRow[];
      documents: TmsDocumentRow[];
      lines: TmsLineItem[];
      driver: TmsPartyRecord | null;
    };

export async function pullTms(
  db: TenantDb,
  session: Session,
  run: { token: string; now: Date; deadlineMs: number },
  deps: PullDeps = {},
): Promise<PullResult> {
  if (flags.tmsSync.enabled !== true) return { ran: false, category: "switched_off" };
  if (!isUuid(run.token)) return { ran: false, category: "no_lease" };
  const s = flags.tmsSync;
  const nowIso = run.now.toISOString();
  const newId = deps.newId ?? randomUUID;
  const inTenant = <T>(fn: (q: Queryable) => Promise<T>) =>
    db.withTenant(session.tenantId, async (q) => {
      await assertMembership(q, session);
      return fn(q);
    });

  // Every transaction that writes goes through here: the lease is checked in it, and a lost lease
  // throws (as the walk save does), so the transaction rolls back and the wake writes nothing more.
  const write = <T>(fn: (q: Queryable) => Promise<T>) =>
    inTenant(async (q) => {
      const held = await q.query<{ held: number }>(HOLD_LEASE_SQL, [run.token]);
      if (held.length !== 1) throw new DbError("unknown");
      return fn(q);
    });

  const [conn] = await inTenant((q) => q.query<ConnectionRow>(CONNECTION_SQL, [run.token, nowIso]));
  if (!conn) return { ran: false, category: "not_configured" };
  if (Number(conn.held) !== 1) return { ran: false, category: "no_lease" };
  if (conn.system !== "synthetic" || typeof conn.zone !== "string" || conn.zone.length === 0) throw new DbError("unknown");
  let labelText: unknown = null;
  try {
    labelText = JSON.parse(conn.label_map) as unknown;
  } catch {
    labelText = null;
  }
  const labelMap = readLabelMap(labelText);
  const connection: TmsConnection = {
    id: conn.id,
    system: "synthetic",
    labelMap,
    lookbackHours: Number(conn.lookback_hours),
    finalizeCooloffMinutes: Number(conn.finalize_cooloff_minutes),
    feedFloorAt: conn.feed_floor_at,
  };
  const zone = conn.zone;
  const source = deps.source ?? tmsSource(connection);
  let walkValue: unknown = null;
  try {
    walkValue = conn.walk === null ? null : (JSON.parse(conn.walk) as unknown);
  } catch {
    walkValue = null;
  }
  const walk = readWalk(walkValue, nowIso);
  const freshPass = conn.walk === null || walkValue === null || walk.below === null;

  // Each source call in its own short tenant transaction (the synthetic feed reads through it).
  const read = <T>(fn: (ctx: TmsContext) => Promise<T>) =>
    inTenant((q) => fn({ tenantId: session.tenantId, zone, now: nowIso, q, connection }));

  const out = {
    listed: 0,
    read: 0,
    written: 0,
    gone: 0,
    failed: 0,
    passComplete: false,
    listFailed: null as string | null,
    stopped: null as "deadline" | null,
  };
  const clock = deps.clock ?? Date.now;
  // Checked before each page, each full read and each verification read. A deadline that is not a
  // number counts as come (fail closed: nothing more is read).
  const outOfTime = () => {
    if (clock() < run.deadlineMs) return false;
    out.stopped = "deadline";
    return true;
  };
  const saveWalk = (w: Walk) =>
    inTenant(async (q) => {
      const n = await q.execute(SAVE_WALK_SQL, [JSON.stringify(w), nowIso, run.token]);
      if (n !== 1) throw new DbError("unknown");
    });
  if (freshPass && walk.below === null) {
    await write((q) =>
      q.execute(
        `UPDATE tms_connections SET last_walk_started_at = CAST($1 AS timestamptz)
          WHERE tenant_id = current_tenant_id() AND last_walk_started_at IS DISTINCT FROM CAST($2 AS timestamptz)`,
        [walk.passStartedAt, walk.passStartedAt],
      ),
    );
  }

  const fullRead = async (externalId: string): Promise<FullRead> => {
    const load = await read((ctx) => source.readLoad(ctx, externalId));
    if (load.kind === "gone") return { kind: "gone" };
    const history: TmsHistoryRow[] = [];
    for (let page = 0; ; page += 1) {
      if (page >= MAX_HISTORY_PAGES) throw new TmsSourceError("malformed");
      const h = await read((ctx) => source.readHistory(ctx, externalId, page));
      // Gone after the record read: unknown for now; the next wake's record read decides.
      if (h.kind === "gone") throw new TmsSourceError("malformed");
      if (h.value.length === 0) break;
      history.push(...h.value);
    }
    const docs = await read((ctx) => source.readDocuments(ctx, externalId));
    const lines = await read((ctx) => source.readLineItems(ctx, externalId));
    if (docs.kind === "gone" || lines.kind === "gone") throw new TmsSourceError("malformed");
    let driver: TmsPartyRecord | null = null;
    const driverId = load.value.driverExternalId;
    if (driverId !== null) {
      const known = await inTenant((q) =>
        q.query<{ n: number }>(
          `SELECT CAST(count(*) AS integer) AS n FROM tms_parties
            WHERE tenant_id = current_tenant_id() AND kind = 'driver' AND external_id = $1`,
          [driverId],
        ),
      );
      if (Number(known[0]?.n ?? 0) === 0) {
        const p = await read((ctx) => source.readParty(ctx, "driver", driverId));
        driver = p.kind === "ok" ? p.value : null;
      }
    }
    return { kind: "ok", record: load.value, history, documents: docs.value, lines: lines.value, driver };
  };

  // One candidate: the full read, then one write transaction (or the failure bookkeeping). `also`
  // runs inside that same transaction (a wake-up's mark), or in one of its own when the outcome
  // writes nothing else.
  const handle = async (
    externalId: string,
    listed: TmsListRow | null,
    mirrored: boolean,
    also?: (q: Queryable) => Promise<unknown>,
  ): Promise<void> => {
    out.read += 1;
    let r: FullRead;
    try {
      r = await fullRead(externalId);
    } catch (err) {
      if (!(err instanceof TmsSourceError)) throw err;
      out.failed += 1;
      if (mirrored) {
        await write(async (q) => {
          await bumpAttempts(q, externalId, listed?.updatedAt ?? null);
          if (also) await also(q);
        });
        return;
      }
      if (listed) {
        const prev = walk.misses[externalId];
        delete walk.misses[externalId];
        walk.misses[externalId] = { n: Math.min((prev?.n ?? 0) + 1, MAX_ATTEMPTS), u: iso(listed.updatedAt) };
        const keys = Object.keys(walk.misses);
        for (const k of keys.slice(0, Math.max(0, keys.length - MAX_MISSES))) delete walk.misses[k];
      }
      if (also) await write(also);
      return;
    }
    if (r.kind === "gone") {
      if (mirrored) {
        const gone = await write(async (q) => {
          const t = await tombstone(q, session, externalId, run.now);
          if (also) await also(q);
          return t;
        });
        if (gone) out.gone += 1;
      } else if (also) {
        await write(also);
      }
      return;
    }
    const wrote = await write(async (q) => {
      const done = await writeLoad(q, { r, listed, labelMap, zone, nowIso, cooloffMinutes: connection.finalizeCooloffMinutes, newId });
      if (also) await also(q);
      return done;
    });
    delete walk.misses[externalId];
    if (wrote) out.written += 1;
  };

  // Wake-ups first (TMS-MIRROR T4): each record the dispatch system named is read again in full
  // before the walk, at most half the wake's reads, so a stream of wake-ups never starves the walk.
  // Each is marked processed in the transaction that records its read, so one the deadline stops
  // waits for the next wake, and one read once is never read again for the same send. A gone load
  // is not read again (the tombstone stands); a resting load is, as its rest allows (read_failed).
  const woken = await write((q) => waitingWakeUps(q, { nowIso, limit: Math.ceil(s.maxReadsPerWake / 2) }));
  for (const w of woken) {
    if (out.read >= s.maxReadsPerWake || outOfTime()) break;
    const mark = (q: Queryable) => markWakeUp(q, w, nowIso);
    if (w.recordType === "load") {
      const [state] = await inTenant((q) =>
        q.query<MirrorState>(
          `SELECT ${STATE_COLUMNS} FROM tms_loads WHERE tenant_id = current_tenant_id() AND external_id = $1`,
          [w.externalId],
        ),
      );
      if (state?.gone) {
        await write(mark);
        continue;
      }
      await handle(w.externalId, null, state !== undefined, mark);
      continue;
    }
    // A customer or a driver: the party read, then its row (by whole external id) and the mark in
    // one transaction. A party gone or of another kind is marked too: one read per send. A failed
    // read is unknown, not a read, so the wake-up stays waiting for the next wake, until it is
    // PARTY_RETRY_MS old; then it is marked, so a party the feed keeps failing is not read forever.
    // Meanwhile it goes behind the wake-ups not yet tried (attemptedWakeUp), so it never holds the batch.
    out.read += 1;
    const kind = w.recordType;
    let party: TmsPartyRecord | null = null;
    try {
      const p = await read((ctx) => source.readParty(ctx, kind, w.externalId));
      if (p.kind === "ok" && p.value.partyKind === kind && p.value.externalId === w.externalId) party = p.value;
    } catch (err) {
      if (!(err instanceof TmsSourceError)) throw err;
      out.failed += 1;
      if (Date.parse(nowIso) - Date.parse(w.receivedAt) < PARTY_RETRY_MS) {
        await write((q) => attemptedWakeUp(q, w, nowIso));
        continue;
      }
    }
    const found = party;
    await write(async (q) => {
      if (found) await upsertParty(q, kind, found.externalId, found.name, found.unit, found.vin, { newId, nowIso });
      await mark(q);
    });
    if (found) out.written += 1;
  }

  let pages = 0;
  while (pages < s.maxPagesPerWake && out.read < s.maxReadsPerWake) {
    if (outOfTime()) break;
    let page: { rows: TmsListRow[]; next: ListBookmark | null };
    try {
      page = await read((ctx) => source.listLoads(ctx, walk.below, s.pageSize));
    } catch (err) {
      if (!(err instanceof TmsSourceError)) throw err;
      out.listFailed = err.category;
      break;
    }
    pages += 1;
    out.listed += page.rows.length;
    const ids = page.rows.map((x) => x.externalId);
    const states = await write(async (q) => {
      if (ids.length === 0) return new Map<string, MirrorState>();
      await q.execute(
        `UPDATE tms_loads SET listed_at = CAST($1 AS timestamptz)
          WHERE tenant_id = current_tenant_id() AND gone_at IS NULL
            AND external_id IN (SELECT jsonb_array_elements_text(CAST($2 AS jsonb)))`,
        [nowIso, JSON.stringify(ids)],
      );
      const rows = await q.query<MirrorState>(
        `SELECT ${STATE_COLUMNS} FROM tms_loads
          WHERE tenant_id = current_tenant_id() AND external_id IN (SELECT jsonb_array_elements_text(CAST($1 AS jsonb)))`,
        [JSON.stringify(ids)],
      );
      return new Map(rows.map((x) => [x.external_id, x]));
    });
    let finished = true;
    for (const row of page.rows) {
      const state = states.get(row.externalId);
      if (!isCandidate(row, state, walk.misses[row.externalId], nowIso)) continue;
      if (out.read >= s.maxReadsPerWake || outOfTime()) {
        finished = false;
        break;
      }
      await handle(row.externalId, row, state !== undefined);
    }
    // The bookmark moves only past a page whose every candidate was handled.
    if (!finished) break;
    if (page.next === null) {
      // The list is done: verify the mirrored loads this pass did not list, within the budget.
      const left = s.maxReadsPerWake - out.read;
      const unseen = await inTenant((q) =>
        q.query<{ external_id: string }>(
          `SELECT external_id FROM tms_loads
            WHERE tenant_id = current_tenant_id() AND gone_at IS NULL AND read_attempts < ${MAX_ATTEMPTS}
              AND (listed_at IS NULL OR listed_at < CAST($1 AS timestamptz))
            ORDER BY external_id LIMIT ${Math.max(0, left) + 1}`,
          [walk.passStartedAt],
        ),
      );
      const now = unseen.slice(0, Math.max(0, left));
      let verified = 0;
      for (const u of now) {
        if (outOfTime()) break;
        verified += 1;
        out.read += 1;
        try {
          const one = await read((ctx) => source.readLoad(ctx, u.external_id));
          if (one.kind === "gone") {
            if (await write((q) => tombstone(q, session, u.external_id, run.now))) out.gone += 1;
          } else {
            await write((q) =>
              q.execute(
                `UPDATE tms_loads SET listed_at = CAST($1 AS timestamptz)
                  WHERE tenant_id = current_tenant_id() AND external_id = $2`,
                [nowIso, u.external_id],
              ),
            );
          }
        } catch (err) {
          if (!(err instanceof TmsSourceError)) throw err;
          out.failed += 1;
          await write((q) => bumpAttempts(q, u.external_id, null));
        }
      }
      // Complete only when every unseen load was verified (none left over, and the deadline did
      // not stop the verification part way); otherwise the next pass verifies again.
      if (verified === now.length && unseen.length <= now.length) {
        await write((q) =>
          q.execute(
            `UPDATE tms_connections SET last_walk_completed_at = CAST($1 AS timestamptz)
              WHERE tenant_id = current_tenant_id()`,
            [nowIso],
          ),
        );
        // The next pass starts just after this run: the rows this run listed belong to the pass
        // it finished, so the next pass's end still verifies a load the list stops showing.
        walk.passStartedAt = new Date(run.now.getTime() + 1).toISOString();
        walk.below = null;
        out.passComplete = true;
      }
      break;
    }
    walk.below = { createdAt: iso(page.next.createdAt), id: page.next.id };
  }
  await saveWalk(walk);
  return { ran: true, ...out };
}

// A read that threw: the mirror stays as it was; attempts go up, and at the cap the load rests
// until its updatedAt moves past the one it rests on (read_failed).
async function bumpAttempts(q: Queryable, externalId: string, listedUpdatedAt: string | null): Promise<void> {
  const [row] = await q.query<MirrorState>(
    `SELECT ${STATE_COLUMNS} FROM tms_loads WHERE tenant_id = current_tenant_id() AND external_id = $1 FOR UPDATE`,
    [externalId],
  );
  if (!row) return;
  const attempts = Math.min(Number(row.read_attempts) + 1, MAX_ATTEMPTS);
  const resting = attempts >= MAX_ATTEMPTS;
  const f = flagsOf(row.flags);
  const next = resting ? uniq([...f, "read_failed"]) : f;
  await q.execute(
    `UPDATE tms_loads SET read_attempts = $1, rest_updated_at = CAST($2 AS timestamptz), flags = CAST($3 AS jsonb)
      WHERE tenant_id = current_tenant_id() AND id = CAST($4 AS uuid)`,
    [attempts, resting ? (listedUpdatedAt ?? row.source_updated_at) : row.rest_updated_at, JSON.stringify(next), row.id],
  );
}

// Gone upstream: the tombstone keeps the row, its link and its history. Once, never retried; a
// load of ours that still runs gets one card for a person. True when this call wrote it.
async function tombstone(q: Queryable, session: Session, externalId: string, now: Date): Promise<boolean> {
  const rows = await q.query<{ load_id: string | null }>(
    `UPDATE tms_loads SET gone_at = CAST($1 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND external_id = $2 AND gone_at IS NULL
      RETURNING CAST(load_id AS text) AS load_id`,
    [now.toISOString(), externalId],
  );
  if (rows.length !== 1) return false;
  if (rows[0].load_id !== null) await tmsGoneCard(q, session, rows[0].load_id, now);
  return true;
}

type WriteInput = {
  r: Extract<FullRead, { kind: "ok" }>;
  listed: TmsListRow | null;
  labelMap: Record<string, TmsStatusCode>;
  zone: string;
  nowIso: string;
  cooloffMinutes: number;
  newId: () => string;
};

const LINK_LOAD_SQL = `SELECT CAST(l.id AS text) AS id FROM loads l
  WHERE l.tenant_id = current_tenant_id() AND l.load_number = $1
    AND NOT EXISTS (SELECT 1 FROM tms_loads m WHERE m.tenant_id = l.tenant_id AND m.load_id = l.id AND m.external_id <> $2)`;

const LOAD_COLUMNS = [
  "reference",
  "status_code",
  "status_label",
  "customer_external_id",
  "driver_external_id",
  "truck_unit",
  "trailer_unit",
  "vin",
  "stop_count",
  "leg_count",
  "picked_up_utc",
  "picked_up_local",
  "picked_up_at",
  "picked_up_day",
  "delivered_utc",
  "delivered_local",
  "delivered_at",
  "delivered_day",
  "last_completed_utc",
  "last_completed_local",
  "last_completed_at",
  "last_completed_day",
  "revenue_total_cents",
  "driver_pay_total_cents",
  "source_updated_at",
  "finalized_at",
] as const;

const CASTS: Partial<Record<(typeof LOAD_COLUMNS)[number], string>> = {
  picked_up_utc: "timestamptz",
  picked_up_at: "timestamptz",
  picked_up_day: "date",
  delivered_utc: "timestamptz",
  delivered_at: "timestamptz",
  delivered_day: "date",
  last_completed_utc: "timestamptz",
  last_completed_at: "timestamptz",
  last_completed_day: "date",
  source_updated_at: "timestamptz",
  finalized_at: "timestamptz",
};

const cast = (n: number, kind?: string) => (kind ? `CAST($${n} AS ${kind})` : `$${n}`);

// The one transaction per load: the load and its stops, line items, new documents and history,
// the links recomputed by whole values, the read bookkeeping cleared. False for a tombstoned load,
// which is never written again.
async function writeLoad(q: Queryable, w: WriteInput): Promise<boolean> {
  const { record } = w.r;
  const mapped = loadColumnsOf(record, w.labelMap, w.zone);
  const [prev] = await q.query<MirrorState>(
    `SELECT ${STATE_COLUMNS} FROM tms_loads WHERE tenant_id = current_tenant_id() AND external_id = $1 FOR UPDATE`,
    [record.externalId],
  );
  if (prev?.gone) return false;

  const links = await q.query<{ id: string }>(LINK_LOAD_SQL, [record.reference, record.externalId]);
  const loadId = links.length === 1 ? links[0].id : null;

  const f: MirrorFlag[] = [...mapped.flags];
  if (loadId === null) f.push("unlinked");
  if (w.listed && w.listed.statusLabel !== record.statusLabel) f.push("stale_list_row");
  const before = flagsOf(prev?.flags ?? null);
  if (before.includes("edited_after_finalize")) f.push("edited_after_finalize");

  // Finalized: the first sight starts the cool-off; the read after it is the recheck; a change
  // after the recheck is flagged for a person, never acted on.
  let finalizedSeenAt = prev?.finalized_seen_at ?? null;
  let recheckAfter = prev?.recheck_after ?? null;
  const nowMs = ms(w.nowIso);
  if (finalizedSeenAt === null && isFinalized(mapped.columns.status_code)) {
    finalizedSeenAt = w.nowIso;
    recheckAfter = new Date(nowMs + w.cooloffMinutes * 60_000).toISOString();
  } else if (finalizedSeenAt !== null && recheckAfter !== null && ms(recheckAfter) <= nowMs) {
    recheckAfter = null;
  } else if (
    finalizedSeenAt !== null &&
    recheckAfter === null &&
    prev &&
    ms(prev.source_updated_at) !== ms(record.updatedAt)
  ) {
    f.push("edited_after_finalize");
  }

  const values = LOAD_COLUMNS.map((c) => mapped.columns[c] as string | number | null);
  const base = 2;
  const colSql = LOAD_COLUMNS.map((c, i) => cast(base + i, CASTS[c])).join(", ");
  const n = base + LOAD_COLUMNS.length;
  const updateSql = LOAD_COLUMNS.map((c) => `${c} = EXCLUDED.${c}`).join(", ");
  const [row] = await q.query<{ id: string }>(
    `INSERT INTO tms_loads (id, tenant_id, external_id, ${LOAD_COLUMNS.join(", ")}, load_id, flags, received_at,
                            finalized_seen_at, recheck_after, listed_at, read_attempts, rest_updated_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), $${n}, ${colSql}, CAST($${n + 1} AS uuid), CAST($${n + 2} AS jsonb),
             CAST($${n + 3} AS timestamptz), CAST($${n + 4} AS timestamptz), CAST($${n + 5} AS timestamptz),
             CAST($${n + 3} AS timestamptz), 0, NULL)
     ON CONFLICT (tenant_id, external_id) DO UPDATE SET ${updateSql}, load_id = EXCLUDED.load_id, flags = EXCLUDED.flags,
             received_at = EXCLUDED.received_at, finalized_seen_at = EXCLUDED.finalized_seen_at,
             recheck_after = EXCLUDED.recheck_after, listed_at = EXCLUDED.listed_at, read_attempts = 0,
             rest_updated_at = NULL
     RETURNING CAST(id AS text) AS id`,
    [w.newId(), ...values, record.externalId, loadId, JSON.stringify(uniq(f)), w.nowIso, finalizedSeenAt, recheckAfter],
  );
  if (!row) throw new DbError("unknown");
  const tmsLoadId = row.id;

  for (const st of mapped.stops) {
    await q.execute(
      `INSERT INTO tms_stops (id, tenant_id, tms_load_id, ordinal, stop_kind, name, city, state, appt_from_local,
                              appt_to_local, appt_from_at, appt_to_at, arrived_utc, arrived_local, arrived_at,
                              completed_utc, completed_local, completed_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, $5, $6, $7, $8, $9,
               CAST($10 AS timestamptz), CAST($11 AS timestamptz), CAST($12 AS timestamptz), $13, CAST($14 AS timestamptz),
               CAST($15 AS timestamptz), $16, CAST($17 AS timestamptz))
       ON CONFLICT (tenant_id, tms_load_id, ordinal) DO UPDATE SET stop_kind = EXCLUDED.stop_kind, name = EXCLUDED.name,
               city = EXCLUDED.city, state = EXCLUDED.state, appt_from_local = EXCLUDED.appt_from_local,
               appt_to_local = EXCLUDED.appt_to_local, appt_from_at = EXCLUDED.appt_from_at, appt_to_at = EXCLUDED.appt_to_at,
               arrived_utc = EXCLUDED.arrived_utc, arrived_local = EXCLUDED.arrived_local, arrived_at = EXCLUDED.arrived_at,
               completed_utc = EXCLUDED.completed_utc, completed_local = EXCLUDED.completed_local,
               completed_at = EXCLUDED.completed_at`,
      [
        w.newId(),
        tmsLoadId,
        st.ordinal,
        st.stop_kind,
        st.name,
        st.city,
        st.state,
        st.appt_from_local,
        st.appt_to_local,
        st.appt_from_at,
        st.appt_to_at,
        st.arrived_utc,
        st.arrived_local,
        st.arrived_at,
        st.completed_utc,
        st.completed_local,
        st.completed_at,
      ],
    );
  }
  await q.execute(
    `DELETE FROM tms_stops WHERE tenant_id = current_tenant_id() AND tms_load_id = CAST($1 AS uuid) AND ordinal >= $2`,
    [tmsLoadId, mapped.stops.length],
  );

  const lines = lineColumnsOf(w.r.lines);
  for (const l of lines) {
    await q.execute(
      `INSERT INTO tms_line_items (id, tenant_id, tms_load_id, external_id, item_group, type_label, description, amount_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, external_id) DO UPDATE SET item_group = EXCLUDED.item_group,
               type_label = EXCLUDED.type_label, description = EXCLUDED.description, amount_cents = EXCLUDED.amount_cents
         WHERE tms_line_items.tms_load_id = EXCLUDED.tms_load_id`,
      [w.newId(), tmsLoadId, l.external_id, l.item_group, l.type_label, l.description, l.amount_cents],
    );
  }
  await q.execute(
    `DELETE FROM tms_line_items WHERE tenant_id = current_tenant_id() AND tms_load_id = CAST($1 AS uuid)
        AND external_id NOT IN (SELECT jsonb_array_elements_text(CAST($2 AS jsonb)))`,
    [tmsLoadId, JSON.stringify(lines.map((l) => l.external_id))],
  );

  for (const d of documentColumnsOf(w.r.documents)) {
    await q.execute(
      `INSERT INTO tms_documents (id, tenant_id, tms_load_id, external_id, file_name, type_label, doc_kind, shared,
                                  uploader_kind, byte_length, source_updated_at, first_seen_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, $5, $6, $7, $8, $9,
               CAST($10 AS timestamptz), CAST($11 AS timestamptz))
       ON CONFLICT (tenant_id, external_id) DO NOTHING`,
      [w.newId(), tmsLoadId, d.external_id, d.file_name, d.type_label, d.doc_kind, d.shared, d.uploader_kind, d.byte_length, d.source_updated_at, w.nowIso],
    );
  }

  for (const e of eventColumnsOf(w.r.history, w.zone)) {
    await q.execute(
      `INSERT INTO tms_status_events (id, tenant_id, tms_load_id, external_event_id, field, new_value, previous_value,
                                      changed_by, at_utc, at_local, at, day, clock_flag, received_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, $5, $6, $7, CAST($8 AS timestamptz), $9,
               CAST($10 AS timestamptz), CAST($11 AS date), $12, CAST($13 AS timestamptz))
       ON CONFLICT (tenant_id, external_event_id) DO NOTHING`,
      [
        w.newId(),
        tmsLoadId,
        e.external_event_id,
        e.field.slice(0, 60),
        e.new_value === null ? null : e.new_value.slice(0, 120),
        e.previous_value === null ? null : e.previous_value.slice(0, 120),
        e.changed_by,
        e.at_utc,
        e.at_local,
        e.at,
        e.day,
        e.clock_flag,
        w.nowIso,
      ],
    );
  }

  if (record.customer) await upsertParty(q, "customer", record.customer.externalId, record.customer.name, null, null, w);
  const d = w.r.driver;
  if (d && d.partyKind === "driver") await upsertParty(q, "driver", d.externalId, d.name, d.unit, d.vin, w);
  return true;
}

// A party by its whole external id; linked to ours by whole value only (customers.code, the
// driver's tms identity), and only when exactly one row matches.
async function upsertParty(
  q: Queryable,
  kind: "customer" | "driver",
  externalId: string,
  name: string,
  unit: string | null,
  vin: string | null,
  w: Pick<WriteInput, "newId" | "nowIso">,
): Promise<void> {
  const link =
    kind === "customer"
      ? `(SELECT CASE WHEN count(*) = 1 THEN min(CAST(c.id AS text)) END FROM customers c
           WHERE c.tenant_id = current_tenant_id() AND c.code = $3)`
      : `(SELECT CASE WHEN count(*) = 1 THEN min(CAST(i.driver_id AS text)) END FROM driver_identities i
           WHERE i.tenant_id = current_tenant_id() AND i.system = 'tms' AND i.external_id = $3)`;
  const customer = kind === "customer" ? `CAST(${link} AS uuid)` : "NULL";
  const driver = kind === "driver" ? `CAST(${link} AS uuid)` : "NULL";
  await q.execute(
    `INSERT INTO tms_parties (id, tenant_id, kind, external_id, name, unit, vin, customer_id, driver_id, received_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), $2, $3, $4, $5, $6, ${customer}, ${driver}, CAST($7 AS timestamptz))
     ON CONFLICT (tenant_id, kind, external_id) DO UPDATE SET name = EXCLUDED.name, unit = EXCLUDED.unit,
             vin = EXCLUDED.vin, customer_id = EXCLUDED.customer_id, driver_id = EXCLUDED.driver_id,
             received_at = EXCLUDED.received_at`,
    [w.newId(), kind, externalId, name, unit, vin, w.nowIso],
  );
}



// Settings > Demo's "Sync dispatch now": one pull under the desk loop's own lease, so it never
// runs beside a wake (busy when the lease is held). The lease is released after, whatever happened.
export const SYNC_NOW_LEASE_MS = 60_000;

const CLAIM_ROW_SQL = `INSERT INTO desk_loops (tenant_id, updated_at)
VALUES (current_tenant_id(), CAST($1 AS timestamptz)) ON CONFLICT (tenant_id) DO NOTHING`;

const CLAIM_LEASE_SQL = `UPDATE desk_loops
    SET lease_token = CAST($2 AS uuid), lease_until = CAST($3 AS timestamptz), updated_at = CAST($1 AS timestamptz)
  WHERE tenant_id = current_tenant_id() AND (lease_until IS NULL OR lease_until < CAST($1 AS timestamptz))`;

const RELEASE_SQL = `UPDATE desk_loops SET lease_token = NULL, lease_until = NULL, updated_at = CAST($2 AS timestamptz)
  WHERE tenant_id = current_tenant_id() AND lease_token = CAST($1 AS uuid)`;

// The button's pull stops by this long after it starts, well inside the route's maxDuration (30
// seconds), so the walk is saved and the lease released before the route could be cut off.
export const SYNC_NOW_BUDGET_MS = 20_000;

export type SyncNowResult = { ok: true; result: PullResult } | { ok: false; category: "switched_off" | "busy" };

export async function syncDispatchNow(
  db: TenantDb,
  session: Session,
  now: Date,
  deps: PullDeps & { token?: string } = {},
): Promise<SyncNowResult> {
  if (flags.tmsSync.enabled !== true) return { ok: false, category: "switched_off" };
  const deadlineMs = (deps.clock ?? Date.now)() + SYNC_NOW_BUDGET_MS;
  const token = deps.token ?? randomUUID();
  const nowIso = now.toISOString();
  const inTenant = <T>(fn: (q: Queryable) => Promise<T>) =>
    db.withTenant(session.tenantId, async (q) => {
      await assertMembership(q, session);
      return fn(q);
    });
  const claimed = await inTenant(async (q) => {
    await q.execute(CLAIM_ROW_SQL, [nowIso]);
    return q.execute(CLAIM_LEASE_SQL, [nowIso, token, new Date(now.getTime() + SYNC_NOW_LEASE_MS).toISOString()]);
  });
  if (claimed !== 1) return { ok: false, category: "busy" };
  try {
    return { ok: true, result: await pullTms(db, session, { token, now, deadlineMs }, deps) };
  } finally {
    await inTenant((q) => q.execute(RELEASE_SQL, [token, nowIso]));
  }
}
