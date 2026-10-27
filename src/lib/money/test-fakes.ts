// Test doubles for the money executor and the reconcile pass: an in-memory ledger that keeps the
// same state machine as the table's trigger, a TenantDb that records transactions and rolls the
// ledger back on a throw, and a recording wrapper around a payment adapter. Tests only.

import type { PaymentAdapter, PayoutRequest, SendContext } from "../adapters/types";
import type { Session } from "../auth/claims";
import type { Queryable, TenantDb } from "../db";
import { ForbiddenError } from "../tenant/context";
import type { LedgerStore } from "./execute";
import { idempotencyKey, requestIdOf } from "./keys";
import { switchOn, validateDraft, type Settlement } from "./ledger";
import {
  KIND_SHAPES,
  MAX_CHECKS,
  MONEY_ACTION_KINDS,
  MoneyError,
  type Approval,
  type MoneyAction,
  type MoneyDraft,
} from "./types";

export const TENANT = "11111111-1111-4111-8111-111111111111";
export const MEMBER = "22222222-2222-4222-8222-222222222222";
export const DRIVER = "33333333-3333-4333-8333-333333333333";
export const ADVANCE = "44444444-4444-4444-8444-444444444444";
export const SESSION: Session = { sub: "person-1", email: "", tenantId: TENANT };

let idCounter = 0;
// Deterministic ids for the executor's newActionId.
export function nextId(): string {
  idCounter += 1;
  return `aaaaaaaa-0000-4000-8000-${String(idCounter).padStart(12, "0")}`;
}

export function payoutDraft(over: Partial<MoneyDraft> = {}): MoneyDraft {
  return {
    kind: "advance_payout",
    subjectId: ADVANCE,
    counterpartyId: DRIVER,
    amountCents: 25_000,
    proposedBy: "agent",
    subjectStatuses: ["requested"],
    ...over,
  };
}

type Snapshot = { rows: Map<string, MoneyAction>; subjects: Map<string, string | null> };

export class FakeLedger {
  rows = new Map<string, MoneyAction>();
  // subject id -> status (null for a table without one)
  subjects = new Map<string, string | null>([[ADVANCE, "requested"]]);
  counterparties = new Map<string, string>([[ADVANCE, DRIVER]]);
  events: string[] = [];
  zone = "America/Chicago";
  // Seconds a sent row reports as its age (the database clock in the real store).
  sentAgeSeconds = 0;
  // The kinds each pending read asked for.
  pendingKinds: string[][] = [];

  snapshot(): Snapshot {
    const rows = new Map<string, MoneyAction>();
    for (const [k, v] of this.rows) rows.set(k, { ...v });
    return { rows, subjects: new Map(this.subjects) };
  }

  restore(s: Snapshot): void {
    this.rows = s.rows;
    this.subjects = s.subjects;
  }

  row(id: string): MoneyAction {
    const r = this.rows.get(id);
    if (!r) throw new Error("no such row");
    return r;
  }

  only(): MoneyAction {
    if (this.rows.size !== 1) throw new Error(`expected one row, found ${this.rows.size}`);
    return [...this.rows.values()][0];
  }

  private age(r: MoneyAction): MoneyAction {
    return { ...r, sentSecondsAgo: r.sentAt === null ? null : this.sentAgeSeconds };
  }

  store: LedgerStore = {
    approvalFrom: async (_q, session) => {
      this.events.push("approval");
      if (session.sub !== SESSION.sub || session.tenantId !== TENANT) throw new ForbiddenError();
      return { membershipId: MEMBER, role: "staff", sub: session.sub } as Approval;
    },
    tenantZone: async () => this.zone,
    reserve: async (_q, approval, draft, actionId) => {
      this.events.push("reserve");
      const d = validateDraft(draft);
      const shape = KIND_SHAPES[d.kind];
      if (!switchOn(shape.channel)) throw new MoneyError("disabled");
      if (this.counterparties.get(d.subjectId) !== d.counterpartyId) {
        throw new MoneyError("validation");
      }
      const key = idempotencyKey(d.kind, d.subjectId, d.attempt);
      const existing = [...this.rows.values()].find((r) => r.idempotencyKey === key);
      if (existing) {
        if (existing.amountCents !== d.amountCents) throw new MoneyError("duplicate");
        return { action: this.age(existing), created: false };
      }
      const status = this.subjects.get(d.subjectId) ?? null;
      if (d.subjectStatuses && (status === null || !d.subjectStatuses.includes(status))) {
        throw new MoneyError("validation");
      }
      const live = [...this.rows.values()].some(
        (r) => r.kind === d.kind && r.subjectId === d.subjectId && r.state !== "failed",
      );
      if (live) throw new MoneyError("duplicate");
      const id = actionId ?? nextId();
      const row: MoneyAction = {
        id,
        tenantId: TENANT,
        kind: d.kind,
        channel: shape.channel,
        subjectTable: shape.subjectTable,
        subjectId: d.subjectId,
        attempt: d.attempt,
        idempotencyKey: key,
        requestId: requestIdOf(id),
        amountCents: d.amountCents,
        counterpartyTable: shape.counterpartyTable,
        counterpartyId: d.counterpartyId,
        state: "reserved",
        failureCategory: null,
        settledVia: null,
        outsideSystem: null,
        outsideType: null,
        outsideId: null,
        outsideRef: null,
        outsideAmountCents: null,
        proposedBy: d.proposedBy,
        proposalId: d.proposalId,
        traceId: d.traceId,
        approverMembershipId: approval.membershipId,
        checkCount: 0,
        createdAt: "2026-11-02T15:00:00.000Z",
        sentAt: null,
        settledAt: null,
        lastCheckedAt: null,
        sentSecondsAgo: null,
      };
      this.rows.set(id, row);
      return { action: { ...row }, created: true };
    },
    markSent: async (_q, id) => {
      this.events.push("markSent");
      const r = this.row(id);
      if (r.state !== "reserved") return false;
      this.rows.set(id, { ...r, state: "sent", sentAt: "2026-11-02T15:00:01.000Z" });
      return true;
    },
    settle: async (_q, id, s: Settlement) => {
      this.events.push(`settle:${s.to}${"via" in s ? `:${s.via}` : ""}`);
      const r = this.row(id);
      if (s.to === "unknown") {
        if (r.state !== "sent") return false;
        this.rows.set(id, { ...r, state: "unknown", failureCategory: s.category });
        return true;
      }
      const from =
        s.via === "response"
          ? r.state === "sent"
          : s.via === "read_back"
            ? (r.state === "sent" || r.state === "unknown") && r.checkCount < MAX_CHECKS
            : r.state === "reserved";
      if (!from) return false;
      const outside = "outside" in s ? s.outside : undefined;
      if (s.to === "confirmed" && outside?.amountCents !== r.amountCents) {
        throw new Error("check violation: confirmed amount differs");
      }
      const read = s.via === "read_back";
      this.rows.set(id, {
        ...r,
        state: s.to,
        settledVia: s.via,
        settledAt: "2026-11-02T15:00:02.000Z",
        failureCategory: s.to === "failed" ? s.category : null,
        outsideSystem: outside?.system ?? null,
        outsideType: outside?.type ?? null,
        outsideId: outside?.id ?? null,
        outsideRef: outside?.ref ?? null,
        outsideAmountCents: outside?.amountCents ?? null,
        checkCount: read ? r.checkCount + 1 : r.checkCount,
        lastCheckedAt: read ? "2026-11-02T15:00:02.000Z" : r.lastCheckedAt,
      });
      return true;
    },
    bumpCheck: async (_q, id, category) => {
      this.events.push("bump");
      const r = this.row(id);
      if ((r.state !== "sent" && r.state !== "unknown") || r.checkCount >= MAX_CHECKS) return false;
      this.rows.set(id, {
        ...r,
        state: "unknown",
        failureCategory: category,
        checkCount: r.checkCount + 1,
        lastCheckedAt: "2026-11-02T15:00:03.000Z",
      });
      return true;
    },
    readAction: async (_q, id) => this.age(this.row(id)),
    // Same filter and order as the real read: the given kinds only, never-checked rows first,
    // then the least recently checked, then the oldest send, then the id.
    readPending: async (_q, olderThanSeconds, limit = 5, kinds = MONEY_ACTION_KINDS) => {
      if (kinds.length === 0) throw new RangeError("kinds must name at least one kind");
      this.pendingKinds.push([...kinds]);
      const order = (a: string | null, b: string | null) =>
        a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1;
      return [...this.rows.values()]
        .filter(
          (r) =>
            kinds.includes(r.kind) &&
            r.checkCount < MAX_CHECKS &&
            (r.state === "unknown" ||
              (r.state === "sent" && this.sentAgeSeconds > olderThanSeconds)),
        )
        .sort(
          (a, b) =>
            order(a.lastCheckedAt, b.lastCheckedAt) ||
            order(a.sentAt, b.sentAt) ||
            order(a.id, b.id),
        )
        .slice(0, limit)
        .map((r) => this.age(r));
    },
  };
}

// Records SQL a hook runs; answers every statement with no rows and one row affected.
export function recordingQueryable(events: string[]): Queryable {
  return {
    async query<T>(sql: string): Promise<T[]> {
      events.push(`sql:${sql}`);
      return [];
    },
    async execute(sql: string): Promise<number> {
      events.push(`sql:${sql}`);
      return 1;
    },
  };
}

// One transaction per withTenant call: begin, then commit, or roll the ledger back on a throw.
export class FakeDb implements TenantDb {
  transactions = 0;
  constructor(private readonly ledger: FakeLedger) {}

  async withTenant<T>(tenantId: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
    if (tenantId !== TENANT) throw new Error("wrong tenant");
    this.transactions += 1;
    const snap = this.ledger.snapshot();
    this.ledger.events.push("begin");
    try {
      const out = await fn(recordingQueryable(this.ledger.events));
      this.ledger.events.push("commit");
      return out;
    } catch (err) {
      this.ledger.restore(snap);
      this.ledger.events.push("rollback");
      throw err;
    }
  }
}

// Delegates to an adapter and records each outside call in the ledger's event list.
export function recordingPayment(inner: PaymentAdapter, events: string[]): PaymentAdapter & {
  sends: number;
  readBacks: number;
} {
  const out = {
    system: inner.system,
    sends: 0,
    readBacks: 0,
    ready: () => inner.ready(),
    async sendPayout(p: PayoutRequest, ctx: SendContext) {
      out.sends += 1;
      events.push("send");
      return inner.sendPayout(p, ctx);
    },
    async readBack(ref: Parameters<PaymentAdapter["readBack"]>[0], ctx: SendContext) {
      out.readBacks += 1;
      events.push("readBack");
      return inner.readBack(ref, ctx);
    },
  };
  return out;
}

// The order of the named events (transactions and SQL left out).
export function steps(events: string[]): string[] {
  return events.filter((e) => !e.startsWith("sql:"));
}
