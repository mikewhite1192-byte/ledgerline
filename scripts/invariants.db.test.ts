import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgDb } from "../src/lib/db/pg";
import { adminUrl } from "../src/lib/db/test-urls";
import type { Db, Param, Queryable } from "../src/lib/db/types";
import { runInvariants, type InvariantResult } from "../src/lib/invariants";
import { PROBE_TENANT_SLUGS } from "../src/lib/invariants/rls";
import { INVOICES_AFTER_SQL, INVOICES_FIRST_SQL, type InvoiceRow } from "../src/lib/invariants/ledger";
import { READ_ONLY_SNAPSHOT_SQL, READ_ONLY_SQL, readAll, readPaged } from "../src/lib/invariants/types";
import { dropDatabase, freshSeededDatabase } from "./lib/fresh-seeded-db";

// Each invariant against a real database: a throwaway one built from every migration and seeded
// for both invented carriers. It passes on the clean seed, and on the seed with a row in every
// tenant table for both carriers; then each planted violation makes exactly its check fail (the
// other four still pass), and taking the plant out makes it pass again. The database is dropped
// at the end, failures included.

const NAME = `payday_inv_t${randomBytes(4).toString("hex")}`;
const server = new URL(adminUrl());
let url: URL;
let admin: Db;
let app: Db;

type Carrier = {
  id: string;
  membership: string;
  driver: string;
  settlement: { id: string; net: number; driver: string; period: string };
  advance: { id: string; recovered: number };
  invoice: { id: string; customer: string; paidOn: string };
  input: string;
};
const carriers: Carrier[] = [];
const ids = { proposals: [] as string[], accountingRows: [] as string[] };

const sql = (statement: string, params: Param[] = []) => admin.withoutTenant((q) => q.execute(statement, params));
const rows = <T>(statement: string, params: Param[] = []) =>
  admin.withoutTenant((q) => q.query<T>(statement, params));

const run = () => runInvariants({ admin, app });

function byId(results: InvariantResult[]): Record<string, InvariantResult> {
  return Object.fromEntries(results.map((r) => [r.id, r]));
}

async function expectAllPass(): Promise<Record<string, InvariantResult>> {
  const results = await run();
  for (const r of results) expect({ id: r.id, verdict: r.verdict, violations: r.violations, unknown: r.unknown }).toEqual({
    id: r.id,
    verdict: "PASS",
    violations: {},
    unknown: [],
  });
  return byId(results);
}

// Plants a violation, checks that only `id` fails and with exactly `violations`, then takes the
// plant out (always) and checks every invariant passes again.
async function planted(
  id: string,
  plant: () => Promise<unknown>,
  undo: () => Promise<unknown>,
  violations: Record<string, number>,
  unknown: string[] = [],
): Promise<void> {
  try {
    await plant();
    const results = await run();
    for (const r of results) {
      if (r.id === id) expect({ verdict: r.verdict, violations: r.violations, unknown: r.unknown }).toEqual({ verdict: "FAIL", violations, unknown });
      else expect({ id: r.id, verdict: r.verdict }).toEqual({ id: r.id, verdict: "PASS" });
    }
  } finally {
    await undo();
  }
  await expectAllPass();
}

// A proposal a person decided at a fixed time, and the confirmed payout of a paid week that
// names it, sent `early` before that decision (the decision is the app host's clock, the send
// the database's). Fixed times, so the wall clock never matters. Undo deletes both.
const DECIDED_AT = "2026-10-01T15:00:00.000Z";
function payoutSentEarly(early: string) {
  const c = carriers[0];
  const proposal = randomUUID();
  const action = randomUUID();
  const plant = () =>
    admin.withoutTenant(async (q) => {
      await q.execute(
        `INSERT INTO proposals (id, tenant_id, conversation_id, turn_id, kind, subject_table, subject_id,
           amount_cents, direction, title, args, operator_verdict, gateway_decision_id, dedupe_key, trace_id,
           status, decided_by, decided_at)
         SELECT CAST($1 AS uuid), tenant_id, conversation_id, turn_id, kind, subject_table, subject_id,
                amount_cents, direction, title, args, operator_verdict, gateway_decision_id, $3, trace_id,
                'done', 'invariants-test', CAST($4 AS timestamptz)
           FROM proposals WHERE id = CAST($2 AS uuid)`,
        [proposal, ids.proposals[0], `advance_payout:${c.driver}:${randomBytes(32).toString("hex")}`, DECIDED_AT],
      );
      await q.execute(
        `INSERT INTO money_actions (id, tenant_id, kind, channel, subject_table, subject_id, attempt,
           idempotency_key, request_id, amount_cents, counterparty_table, counterparty_id, proposed_by,
           proposal_id, approver_membership_id)
         VALUES (CAST($1 AS uuid), CAST($2 AS uuid), 'settlement_payout', 'payment', 'settlements',
           CAST($3 AS uuid), 1, $4, $5, $6, 'drivers', CAST($7 AS uuid), 'agent', CAST($8 AS uuid),
           CAST($9 AS uuid))`,
        [
          action,
          c.id,
          c.settlement.id,
          `settlement_payout:${c.settlement.id}:1`,
          action.replace(/-/g, ""),
          c.settlement.net,
          c.settlement.driver,
          proposal,
          c.membership,
        ],
      );
      await q.execute(
        `UPDATE money_actions SET state = 'sent', sent_at = CAST($2 AS timestamptz) - CAST($3 AS interval)
          WHERE id = CAST($1 AS uuid)`,
        [action, DECIDED_AT, early],
      );
      await q.execute(
        `UPDATE money_actions SET state = 'confirmed', settled_via = 'response', settled_at = now(),
           outside_system = 'mock', outside_type = 'payout', outside_id = 'po_test', outside_amount_cents = $2
         WHERE id = CAST($1 AS uuid)`,
        [action, c.settlement.net],
      );
    });
  const undo = async () => {
    await sql("DELETE FROM money_actions WHERE id = CAST($1 AS uuid)", [action]);
    await sql("DELETE FROM proposals WHERE id = CAST($1 AS uuid)", [proposal]);
  };
  return { plant, undo };
}

beforeAll(async () => {
  url = await freshSeededDatabase(server, NAME);
  admin = createPgDb({ connectionString: url.toString(), max: 2 });
  const appUrl = new URL(url);
  appUrl.username = "payday_app";
  appUrl.password = "";
  app = createPgDb({ connectionString: appUrl.toString(), max: 2 });

  for (const slug of PROBE_TENANT_SLUGS) {
    const [t] = await rows<{ id: string }>("SELECT CAST(id AS text) AS id FROM tenants WHERE slug = $1", [slug]);
    const one = async <T>(statement: string) => {
      const [row] = await rows<T>(statement, [t.id]);
      if (!row) throw new Error(`fixture: nothing for ${slug}`);
      return row;
    };
    const membership = await one<{ id: string }>(
      "SELECT CAST(id AS text) AS id FROM memberships WHERE tenant_id = CAST($1 AS uuid) ORDER BY id LIMIT 1",
    );
    const settlement = await one<{ id: string; net: number; driver: string; period: string }>(
      `SELECT CAST(id AS text) AS id, net_cents AS net, CAST(driver_id AS text) AS driver,
              CAST(period_id AS text) AS period
         FROM settlements WHERE tenant_id = CAST($1 AS uuid) AND status = 'paid' AND net_cents > 0
        ORDER BY id LIMIT 1`,
    );
    const advance = await one<{ id: string; recovered: number }>(
      `SELECT CAST(id AS text) AS id, recovered_cents AS recovered FROM advances
        WHERE tenant_id = CAST($1 AS uuid) AND source = 'seed' AND status = 'paid' AND recovered_cents > 0
        ORDER BY id LIMIT 1`,
    );
    const invoice = await one<{ id: string; customer: string; paidOn: string }>(
      `SELECT CAST(id AS text) AS id, CAST(customer_id AS text) AS customer, CAST(paid_on AS text) AS "paidOn"
         FROM invoices WHERE tenant_id = CAST($1 AS uuid) AND status = 'paid' ORDER BY id LIMIT 1`,
    );
    const input = await one<{ id: string }>(
      "SELECT CAST(id AS text) AS id FROM untrusted_inputs WHERE tenant_id = CAST($1 AS uuid) ORDER BY id LIMIT 1",
    );
    carriers.push({
      id: t.id,
      membership: membership.id,
      driver: settlement.driver,
      settlement,
      advance,
      invoice,
      input: input.id,
    });
  }
}, 180_000);

afterAll(async () => {
  await Promise.allSettled([admin?.close(), app?.close()]);
  await dropDatabase(server, NAME);
}, 60_000);

describe("the money invariants on a real database", { timeout: 60_000 }, () => {
  let clean: Record<string, InvariantResult>;

  it("all five pass on the clean seed, having read real rows", async () => {
    clean = await expectAllPass();
    expect(clean.I1.counts.settlements).toBeGreaterThan(0);
    expect(clean.I1.counts.invoices).toBeGreaterThan(0);
    expect(clean.I3.counts.history_paid).toBeGreaterThan(0);
    expect(clean.I5.counts.probed).toBe(clean.I5.counts.tables);
    expect(clean.I5.counts.no_select ?? 0).toBe(0);
    expect(clean.I5.counts.both_tenants).toBeGreaterThan(0);
  });

  // Every table the seed leaves empty gets one row per carrier, written as the app writes it, so
  // the live probe has something of the other carrier's to (not) see in every table.
  const FILLED = [
    "conversations",
    "turns",
    "gateway_decisions",
    "turn_steps",
    "proposals",
    "money_actions",
    "model_calls",
    "driver_notes",
    "screenings",
    "qbo_connections",
    "qbo_entity_ids",
    "qbo_oauth_states",
    "spend_alerts",
    "voice_notes",
    "voice_note_audio",
    "documents",
    "portal_runs",
    "portal_sessions",
    "portal_run_steps",
    "portal_run_checks",
    "portal_evidence",
    "evidence_clips",
    "sweep_runs",
    "sweep_items",
    "approval_batches",
    // Seeded, but filled here as a person writes them too (0027), so the probe also reads rows the
    // app role wrote.
    "driver_arm_events",
    "driver_identities",
    "pay_rule_changes",
  ];

  it("all five pass with a row in every tenant table for both carriers, and the probe reads them", async () => {
    let emptyBefore = 0;
    for (const table of FILLED) {
      const [r] = await rows<{ n: number }>(`SELECT count(DISTINCT tenant_id) AS n FROM public.${table}`);
      if (r.n < 2) emptyBefore += 1;
    }
    for (const c of carriers) {
      const [conversation, turn, decision, proposal, action, note] = Array.from({ length: 6 }, () => randomUUID());
      const trace = `trace-${turn.slice(0, 8)}`;
      await app.withTenant(c.id, async (q: Queryable) => {
        await q.execute(
          "INSERT INTO conversations (id, tenant_id, created_by) VALUES (CAST($1 AS uuid), current_tenant_id(), 'invariants-test')",
          [conversation],
        );
        await q.execute(
          `INSERT INTO turns (id, tenant_id, conversation_id, seq, user_text, status, trace_id, finished_at)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 1, 'Can this driver get an advance?',
             'done', $3, now())`,
          [turn, conversation, trace],
        );
        await q.execute(
          `INSERT INTO gateway_decisions (id, tenant_id, turn_id, trace_id, role, model, tool, tier, decision,
             reason, latency_ms)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, 'operator', 'spark',
             'propose_advance', 'propose', 'allowed', 'ok', 1)`,
          [decision, turn, trace],
        );
        await q.execute(
          `INSERT INTO turn_steps (id, tenant_id, turn_id, seq, kind, label, state, gateway_decision_id, finished_at)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 1, 'proposal', 'Proposing an advance',
             'done', CAST($3 AS uuid), now())`,
          [randomUUID(), turn, decision],
        );
        await q.execute(
          `INSERT INTO proposals (id, tenant_id, conversation_id, turn_id, kind, subject_table, subject_id,
             amount_cents, direction, title, args, operator_verdict, gateway_decision_id, dedupe_key, trace_id)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'advance_payout',
             'drivers', CAST($4 AS uuid), 10000, 'out', 'Pay an advance', CAST('{}' AS jsonb), 'eligible',
             CAST($5 AS uuid), $6, $7)`,
          [proposal, conversation, turn, c.driver, decision, `advance_payout:${c.driver}:${"0".repeat(64)}`, trace],
        );
        // An invoice post a person approved, refused before any call (the switch was off).
        await q.execute(
          `INSERT INTO money_actions (id, tenant_id, kind, channel, subject_table, subject_id, attempt,
             idempotency_key, request_id, amount_cents, counterparty_table, counterparty_id, proposed_by,
             approver_membership_id)
           VALUES (CAST($1 AS uuid), current_tenant_id(), 'invoice', 'accounting', 'invoices', CAST($2 AS uuid), 1,
             $3, $4, 100, 'customers', CAST($5 AS uuid), 'person', CAST($6 AS uuid))`,
          [action, c.invoice.id, `invoice:${c.invoice.id}:1`, action.replace(/-/g, ""), c.invoice.customer, c.membership],
        );
        await q.execute(
          `UPDATE money_actions SET state = 'failed', settled_via = 'refused', settled_at = now(),
             failure_category = 'disabled'
           WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
          [action],
        );
        // A model call that timed out: settled, nothing spent.
        await q.execute(
          `INSERT INTO model_calls (tenant_id, provider, model, purpose, status, failure, reserved_nanocents,
             cost_nanocents, target, kind, settled_at)
           VALUES (current_tenant_id(), 'meta', 'muse-spark', 'invariants_test', 'failed', 'timeout', 0, 0,
             'spark', 'text', now())`,
        );
        await q.execute(
          `INSERT INTO driver_notes (id, tenant_id, settlement_id, driver_id, period_id, language, status, trace_id)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid), 'en',
             'drafting', CAST($5 AS uuid))`,
          [note, c.settlement.id, c.settlement.driver, c.settlement.period, randomUUID()],
        );
        await q.execute(
          `INSERT INTO screenings (id, tenant_id, input_id, content_hash, verdict, via, latency_ms)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, 'clean', 'pattern', 1)`,
          [randomUUID(), c.input, randomBytes(32).toString("hex")],
        );
        await q.execute(
          `INSERT INTO qbo_connections (tenant_id, realm_id, access_token_enc, refresh_token_enc, access_expires_at,
             refresh_expires_at, account_map, item_map, connected_by_membership_id)
           VALUES (current_tenant_id(), $1, decode($2, 'hex'), decode($2, 'hex'), now() + interval '1 hour',
             now() + interval '100 days', CAST('{}' AS jsonb), CAST('{}' AS jsonb), CAST($3 AS uuid))`,
          [`000000000${carriers.indexOf(c) + 1}`, "00".repeat(32), c.membership],
        );
        await q.execute(
          `INSERT INTO qbo_entity_ids (id, tenant_id, local_table, local_id, entity_type, outside_id)
           VALUES (CAST($1 AS uuid), current_tenant_id(), 'drivers', CAST($2 AS uuid), 'Vendor', '1')`,
          [randomUUID(), c.driver],
        );
        await q.execute(
          `INSERT INTO qbo_oauth_states (id, tenant_id, state, membership_id)
           VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid))`,
          [randomUUID(), randomBytes(32).toString("base64url"), c.membership],
        );
        // A job the spend watch stopped, still waiting for an admin to clear it.
        await q.execute(
          `INSERT INTO spend_alerts (tenant_id, purpose, window_start, window_end, spent_nanocents, limit_nanocents)
           VALUES (current_tenant_id(), 'invariants_test', now() - interval '1 hour', now(), 2, 1)`,
        );
        // A driver's voice note, just transcribed, with its recording (0012).
        const voiceNote = randomUUID();
        await q.execute(
          `INSERT INTO voice_notes (id, tenant_id, driver_id, trace_id, created_by, status, duration_ms)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'invariants-test',
             'transcribed', 1000)`,
          [voiceNote, c.driver, randomUUID()],
        );
        await q.execute(
          `INSERT INTO voice_note_audio (tenant_id, voice_note_id, audio, audio_mime, audio_bytes)
           VALUES (current_tenant_id(), CAST($1 AS uuid), decode($2, 'hex'), 'audio/wav', 4)`,
          [voiceNote, "52494646"],
        );
        // An uploaded receipt not read yet (0013).
        await q.execute(
          `INSERT INTO documents (id, tenant_id, uploaded_by, filename, mime, byte_length, bytes, content_hash,
             trace_id)
           VALUES (CAST($1 AS uuid), current_tenant_id(), 'invariants-test', 'receipt.png', 'image/png', 4,
             decode($2, 'hex'), $3, CAST($4 AS uuid))`,
          [randomUUID(), "89504e47", randomBytes(32).toString("hex"), randomUUID()],
        );
        // A portal run queued for one of the carrier's loads, with its sign-in code, a first step
        // not run yet, a check waiting for a person, and the evidence it read back (0021).
        const [load] = await q.query<{ id: string }>("SELECT CAST(id AS text) AS id FROM loads ORDER BY id LIMIT 1");
        const [run, step] = [randomUUID(), randomUUID()];
        await q.execute(
          `INSERT INTO portal_runs (id, tenant_id, load_id, reference, requested_by, trace_id, model, status)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'FFE-000001', 'invariants-test', $3,
             'spark', 'queued')`,
          [run, load.id, trace],
        );
        await q.execute(
          `INSERT INTO portal_sessions (id, tenant_id, run_id, code_hash, expires_at, created_by)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, now() + interval '10 minutes',
             'invariants-test')`,
          [randomUUID(), run, randomBytes(32).toString("hex")],
        );
        await q.execute(
          `INSERT INTO portal_run_steps (id, tenant_id, run_id, seq, executed)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 0, false)`,
          [step, run],
        );
        await q.execute(
          `INSERT INTO portal_run_checks (id, tenant_id, run_id, step_id, check_id, code, message, status)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'check-1',
             'pending_check', 'Waiting for a person', 'pending')`,
          [randomUUID(), run, step],
        );
        await q.execute(
          `INSERT INTO portal_evidence (id, tenant_id, run_id, load_id, answer, screen_verdict, readback_match)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST('{}' AS jsonb),
             'clean', 'matches')`,
          [randomUUID(), run, load.id],
        );
        // A dock clip uploaded for the same load, not redacted yet (0023).
        await q.execute(
          `INSERT INTO evidence_clips (id, tenant_id, load_id, stop, uploaded_by, filename, raw_hash,
             raw_byte_length, width, height, frames_per_second, frame_count, duration_ms, status)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'delivery', 'invariants-test',
             'dock.mp4', $3, 4, 640, 360, 10, 100, 10000, 'redacting')`,
          [randomUUID(), load.id, randomBytes(32).toString("hex")],
        );
        // A finished sweep of the open week with one finding left for a person, and a batch
        // approval refused before any leg was reserved (0018).
        const sweep = randomUUID();
        await q.execute(
          `INSERT INTO sweep_runs (id, tenant_id, period_id, trigger, started_by, status, phase, cap_cents,
             finished_at)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'button', 'invariants-test', 'done',
             'done', 100, now())`,
          [sweep, c.settlement.period],
        );
        await q.execute(
          `INSERT INTO sweep_items (id, tenant_id, run_id, seen_run_id, period_id, finding_key, check_name,
             category, kind, driver_id, status)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($2 AS uuid), CAST($3 AS uuid),
             'invariants-test', 'invariants_test', 'invariants_test', 'needs_person', CAST($4 AS uuid),
             'needs_person')`,
          [randomUUID(), sweep, c.settlement.period, c.settlement.driver],
        );
        await q.execute(
          `INSERT INTO approval_batches (id, tenant_id, scope, item_ids, total_cents, status, requested_by,
             finished_at)
           VALUES (CAST($1 AS uuid), current_tenant_id(), 'proposals', ARRAY[CAST($2 AS uuid)], 10000, 'refused',
             'invariants-test', now())`,
          [randomUUID(), proposal],
        );
        // A person arming the driver for advances, and the id the carrier's TMS knows them by (0027).
        await q.execute(
          `INSERT INTO driver_arm_events (id, tenant_id, driver_id, armed, note, membership_id, source)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), true, 'invariants-test',
             CAST($3 AS uuid), 'ui')`,
          [randomUUID(), c.driver, c.membership],
        );
        await q.execute(
          `INSERT INTO driver_identities (id, tenant_id, driver_id, system, external_id, source)
           VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'tms', 'invariants-test', 'ui')`,
          [randomUUID(), c.driver],
        );
        // A saved pay rule change on the carrier's first rules version, its proposal long gone
        // (0030).
        await q.execute(
          `INSERT INTO pay_rule_changes (id, tenant_id, pay_config_id, proposal_id, rule_key, old_value, new_value,
             asked_from, effective_from, applied, decided_by)
           SELECT CAST($1 AS uuid), current_tenant_id(), pc.id, NULL, 'insurance_per_day_cents', '1100', '1200',
             pc.effective_from, pc.effective_from, 'edited_version', 'invariants-test'
             FROM pay_configs pc
            WHERE pc.tenant_id = current_tenant_id()
            ORDER BY pc.effective_from
            LIMIT 1`,
          [randomUUID()],
        );
      });
      ids.proposals.push(proposal);
      ids.accountingRows.push(action);
    }
    // The settled calls, as the wrapper counts them.
    await sql("UPDATE ops.ai_spend SET calls = calls + 2 WHERE id = 1");

    const filled = await expectAllPass();
    expect(filled.I5.counts.both_tenants).toBe(clean.I5.counts.both_tenants + emptyBefore);
    // A tenant table added later fails here until FILLED gives it a row per carrier, so the live
    // probe keeps reading every table.
    expect(filled.I5.counts.both_tenants, "a tenant table has no row for both carriers: add it to FILLED").toBe(
      filled.I5.counts.tables,
    );
    expect(filled.I3.counts.linked_proposals ?? 0).toBe(0);
    expect(filled.I4.counts).toEqual({ calls: 2, settled: 2 });
  });

  describe("I1 ledger", () => {
    it("catches a settlement whose net is off by one cent", async () => {
      const s = carriers[0].settlement.id;
      await planted(
        "I1",
        () => sql("UPDATE settlements SET net_cents = net_cents + 1 WHERE id = CAST($1 AS uuid)", [s]),
        () => sql("UPDATE settlements SET net_cents = net_cents - 1 WHERE id = CAST($1 AS uuid)", [s]),
        { settlement_totals_off: 1 },
      );
    });

    it("catches an advance whose recovered amount does not tie out to its recovery lines", async () => {
      const a = carriers[1].advance.id;
      await planted(
        "I1",
        () => sql("UPDATE advances SET recovered_cents = recovered_cents - 1 WHERE id = CAST($1 AS uuid)", [a]),
        () => sql("UPDATE advances SET recovered_cents = recovered_cents + 1 WHERE id = CAST($1 AS uuid)", [a]),
        { recovery_off: 1 },
      );
    });

    it("catches a confirmed payout one cent more than the week's net", async () => {
      const c = carriers[0];
      const action = randomUUID();
      await planted(
        "I1",
        () =>
          admin.withoutTenant(async (q) => {
            await q.execute(
              `INSERT INTO money_actions (id, tenant_id, kind, channel, subject_table, subject_id, attempt,
                 idempotency_key, request_id, amount_cents, counterparty_table, counterparty_id, proposed_by,
                 approver_membership_id)
               VALUES (CAST($1 AS uuid), CAST($2 AS uuid), 'settlement_payout', 'payment', 'settlements',
                 CAST($3 AS uuid), 1, $4, $5, $6, 'drivers', CAST($7 AS uuid), 'person', CAST($8 AS uuid))`,
              [
                action,
                c.id,
                c.settlement.id,
                `settlement_payout:${c.settlement.id}:1`,
                action.replace(/-/g, ""),
                c.settlement.net + 1,
                c.settlement.driver,
                c.membership,
              ],
            );
            await q.execute("UPDATE money_actions SET state = 'sent', sent_at = now() WHERE id = CAST($1 AS uuid)", [action]);
            await q.execute(
              `UPDATE money_actions SET state = 'confirmed', settled_via = 'response', settled_at = now(),
                 outside_system = 'mock', outside_type = 'payout', outside_id = 'po_test', outside_amount_cents = $2
               WHERE id = CAST($1 AS uuid)`,
              [action, c.settlement.net + 1],
            );
          }),
        () => sql("DELETE FROM money_actions WHERE id = CAST($1 AS uuid)", [action]),
        { payout_mismatch: 1 },
      );
    });

    it("catches a customer payment applied for more than it brought in", async () => {
      const [pa] = await rows<{ id: string }>(
        `SELECT CAST(pa.id AS text) AS id FROM payment_applications pa
           JOIN customer_payments p ON p.tenant_id = pa.tenant_id AND p.id = pa.payment_id
           JOIN invoices i ON i.tenant_id = pa.tenant_id AND i.id = pa.invoice_id
          WHERE i.status = 'paid'
            AND p.amount_cents = (SELECT sum(x.amount_cents) FROM payment_applications x
                                   WHERE x.tenant_id = p.tenant_id AND x.payment_id = p.id)
          ORDER BY pa.id LIMIT 1`,
      );
      expect(pa).toBeDefined();
      await planted(
        "I1",
        () => sql("UPDATE payment_applications SET amount_cents = amount_cents + 100 WHERE id = CAST($1 AS uuid)", [pa.id]),
        () => sql("UPDATE payment_applications SET amount_cents = amount_cents - 100 WHERE id = CAST($1 AS uuid)", [pa.id]),
        { payment_overapplied: 1 },
      );
    });

    it("catches a paid invoice marked open", async () => {
      const inv = carriers[1].invoice;
      await planted(
        "I1",
        () => sql("UPDATE invoices SET status = 'open', paid_on = NULL WHERE id = CAST($1 AS uuid)", [inv.id]),
        () =>
          sql("UPDATE invoices SET status = 'paid', paid_on = CAST($2 AS date) WHERE id = CAST($1 AS uuid)", [
            inv.id,
            inv.paidOn,
          ]),
        { invoice_status_off: 1 },
      );
    });
  });

  describe("I2 keys", () => {
    it("catches a missing idempotency key and the duplicate it let in", async () => {
      const c = carriers[0];
      const dup = randomUUID();
      await planted(
        "I2",
        () =>
          admin.withoutTenant(async (q) => {
            await q.execute("ALTER TABLE money_actions DROP CONSTRAINT money_actions_tenant_id_idempotency_key_key");
            await q.execute(
              `INSERT INTO money_actions (id, tenant_id, kind, channel, subject_table, subject_id, attempt,
                 idempotency_key, request_id, amount_cents, counterparty_table, counterparty_id, proposed_by,
                 approver_membership_id)
               VALUES (CAST($1 AS uuid), CAST($2 AS uuid), 'invoice', 'accounting', 'invoices', CAST($3 AS uuid), 1,
                 $4, $5, 100, 'customers', CAST($6 AS uuid), 'person', CAST($7 AS uuid))`,
              [dup, c.id, c.invoice.id, `invoice:${c.invoice.id}:1`, dup.replace(/-/g, ""), c.invoice.customer, c.membership],
            );
          }),
        () =>
          admin.withoutTenant(async (q) => {
            await q.execute("DELETE FROM money_actions WHERE id = CAST($1 AS uuid)", [dup]);
            await q.execute(
              `ALTER TABLE money_actions ADD CONSTRAINT money_actions_tenant_id_idempotency_key_key
                 UNIQUE (tenant_id, idempotency_key)`,
            );
          }),
        { "index_missing:money_actions_tenant_id_idempotency_key_key": 1, "duplicate:money_actions_idempotency": 1 },
      );
    });

    it("catches the one-live-proposal rule narrowed", async () => {
      await planted(
        "I2",
        () =>
          admin.withoutTenant(async (q) => {
            await q.execute("DROP INDEX proposals_one_live_per_subject");
            await q.execute(
              `CREATE UNIQUE INDEX proposals_one_live_per_subject ON proposals (tenant_id, kind, subject_id)
                 WHERE status IN ('proposed', 'approved')`,
            );
          }),
        () =>
          admin.withoutTenant(async (q) => {
            await q.execute("DROP INDEX proposals_one_live_per_subject");
            await q.execute(
              `CREATE UNIQUE INDEX proposals_one_live_per_subject ON proposals (tenant_id, kind, subject_id)
                 WHERE status IN ('proposed', 'approved', 'executing')`,
            );
          }),
        { "index_changed:proposals_one_live_per_subject": 1 },
      );
    });

    it("catches a model call logged twice", async () => {
      const insert = `INSERT INTO model_calls (tenant_id, provider, model, purpose, status, failure,
          reserved_nanocents, cost_nanocents, target, kind, settled_at, upstream_id)
        VALUES (CAST($1 AS uuid), 'meta', 'muse-spark', 'invariants_test', 'failed', 'timeout', 0, 0, 'spark', 'text',
          now(), 'resp_twice')`;
      await planted(
        "I2",
        () =>
          admin.withoutTenant(async (q) => {
            await q.execute(insert, [carriers[0].id]);
            await q.execute(insert, [carriers[0].id]);
            await q.execute("UPDATE ops.ai_spend SET calls = calls + 2 WHERE id = 1");
          }),
        () =>
          admin.withoutTenant(async (q) => {
            await q.execute("DELETE FROM model_calls WHERE upstream_id = 'resp_twice'");
            await q.execute("UPDATE ops.ai_spend SET calls = calls - 2 WHERE id = 1");
          }),
        { "duplicate:model_calls_upstream": 1 },
      );
    });
  });

  describe("I3 approvals", () => {
    it("catches a paid advance with no payout behind it", async () => {
      const a = carriers[0].advance.id;
      await planted(
        "I3",
        () => sql("UPDATE advances SET source = 'ui' WHERE id = CAST($1 AS uuid)", [a]),
        () => sql("UPDATE advances SET source = 'seed' WHERE id = CAST($1 AS uuid)", [a]),
        { advance_paid_without_payout: 1 },
      );
    });

    it("catches an agent's payout on a proposal nobody approved", async () => {
      const c = carriers[1];
      const action = randomUUID();
      await planted(
        "I3",
        () =>
          sql(
            `INSERT INTO money_actions (id, tenant_id, kind, channel, subject_table, subject_id, attempt,
               idempotency_key, request_id, amount_cents, counterparty_table, counterparty_id, proposed_by,
               proposal_id, approver_membership_id)
             VALUES (CAST($1 AS uuid), CAST($2 AS uuid), 'advance_payout', 'payment', 'advances', CAST($3 AS uuid), 1,
               $4, $5, 10000, 'drivers', CAST($6 AS uuid), 'agent', CAST($7 AS uuid), CAST($8 AS uuid))`,
            [
              action,
              c.id,
              c.advance.id,
              `advance_payout:${c.advance.id}:1`,
              action.replace(/-/g, ""),
              c.driver,
              ids.proposals[1],
              c.membership,
            ],
          ),
        () => sql("DELETE FROM money_actions WHERE id = CAST($1 AS uuid)", [action]),
        { proposal_not_approved: 1, proposal_undecided: 1, proposal_mismatch: 1 },
      );
    });

    it("catches a payout sent well before its proposal was decided", async () => {
      const { plant, undo } = payoutSentEarly("1 hour");
      await planted("I3", plant, undo, { sent_before_decision: 1 });
    });

    it("passes a payout sent a few milliseconds before its decision, inside the clock tolerance", async () => {
      const { plant, undo } = payoutSentEarly("3 milliseconds");
      try {
        await plant();
        const passed = await expectAllPass();
        // The plant is the only payment-channel ledger row, so the tolerance is what let it pass.
        expect(passed.I3.counts.payment_rows).toBe(1);
      } finally {
        await undo();
      }
      await expectAllPass();
    });

    it("catches a proposal that names a ledger row before anyone approved it", async () => {
      await planted(
        "I3",
        () =>
          sql("UPDATE proposals SET money_action_id = CAST($2 AS uuid) WHERE id = CAST($1 AS uuid)", [
            ids.proposals[0],
            ids.accountingRows[0],
          ]),
        () => sql("UPDATE proposals SET money_action_id = NULL WHERE id = CAST($1 AS uuid)", [ids.proposals[0]]),
        { proposal_linked_early: 1 },
      );
    });
  });

  describe("I4 model calls", () => {
    it("catches the spend counter drifting from the log by one nanocent", async () => {
      await planted(
        "I4",
        () => sql("UPDATE ops.ai_spend SET spent_nanocents = spent_nanocents + 1 WHERE id = 1"),
        () => sql("UPDATE ops.ai_spend SET spent_nanocents = spent_nanocents - 1 WHERE id = 1"),
        { "counter_off:spent": 1 },
      );
    });

    it("catches an answered call logged without its cost", async () => {
      await planted(
        "I4",
        () =>
          admin.withoutTenant(async (q) => {
            await q.execute(
              `INSERT INTO model_calls (tenant_id, provider, model, purpose, status, reserved_nanocents, target, kind,
                 input_tokens, output_tokens, settled_at, upstream_id)
               VALUES (CAST($1 AS uuid), 'meta', 'muse-spark', 'invariants_test', 'ok', 0, 'spark', 'text', 10, 10,
                 now(), 'resp_costless')`,
              [carriers[0].id],
            );
            await q.execute("UPDATE ops.ai_spend SET calls = calls + 1 WHERE id = 1");
          }),
        () =>
          admin.withoutTenant(async (q) => {
            await q.execute("DELETE FROM model_calls WHERE upstream_id = 'resp_costless'");
            await q.execute("UPDATE ops.ai_spend SET calls = calls - 1 WHERE id = 1");
          }),
        { answered_without_cost: 1 },
      );
    });

    it("catches a reservation that was never settled", async () => {
      await planted(
        "I4",
        () =>
          admin.withoutTenant(async (q) => {
            await q.execute(
              `INSERT INTO model_calls (tenant_id, provider, model, purpose, status, reserved_nanocents, target, kind,
                 created_at)
               VALUES (CAST($1 AS uuid), 'meta', 'muse-spark', 'invariants_stale', 'reserved', 1000, 'spark', 'text',
                 now() - interval '1 hour')`,
              [carriers[1].id],
            );
            await q.execute("UPDATE ops.ai_spend SET reserved_nanocents = reserved_nanocents + 1000 WHERE id = 1");
          }),
        () =>
          admin.withoutTenant(async (q) => {
            await q.execute("DELETE FROM model_calls WHERE purpose = 'invariants_stale'");
            await q.execute("UPDATE ops.ai_spend SET reserved_nanocents = reserved_nanocents - 1000 WHERE id = 1");
          }),
        { stale_reserved: 1 },
      );
    });
  });

  describe("I5 row security", () => {
    it("catches a new tenant table with row security off, and every carrier's rows it shows", async () => {
      await planted(
        "I5",
        () =>
          admin.withoutTenant(async (q) => {
            await q.execute(
              "CREATE TABLE public.inv_probe_open (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants (id))",
            );
            await q.execute("GRANT SELECT ON public.inv_probe_open TO payday_app");
            for (const c of carriers) {
              await q.execute("INSERT INTO public.inv_probe_open (id, tenant_id) VALUES (CAST($1 AS uuid), CAST($2 AS uuid))", [
                randomUUID(),
                c.id,
              ]);
            }
          }),
        () => sql("DROP TABLE IF EXISTS public.inv_probe_open"),
        {
          "rls_off:inv_probe_open": 1,
          "rls_not_forced:inv_probe_open": 1,
          "policy_off:inv_probe_open": 1,
          "cross_tenant_rows:inv_probe_open": 2,
          "no_tenant_rows:inv_probe_open": 1,
        },
      );
    });

    it("catches a new tenant table with no policy", async () => {
      await planted(
        "I5",
        () =>
          admin.withoutTenant(async (q) => {
            await q.execute(
              "CREATE TABLE public.inv_probe_bare (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants (id))",
            );
            await q.execute("ALTER TABLE public.inv_probe_bare ENABLE ROW LEVEL SECURITY");
            await q.execute("ALTER TABLE public.inv_probe_bare FORCE ROW LEVEL SECURITY");
            await q.execute("GRANT SELECT ON public.inv_probe_bare TO payday_app");
          }),
        () => sql("DROP TABLE IF EXISTS public.inv_probe_bare"),
        { "policy_off:inv_probe_bare": 1 },
      );
    });

    it("catches a policy that lets one carrier read another's drivers", async () => {
      await planted(
        "I5",
        () => sql("CREATE POLICY inv_probe_leak ON drivers FOR SELECT USING (true)"),
        () => sql("DROP POLICY IF EXISTS inv_probe_leak ON drivers"),
        { "policy_off:drivers": 1, "cross_tenant_rows:drivers": 2, "no_tenant_rows:drivers": 1 },
      );
    });

    it("catches an insert let through with no carrier set, and leaves nothing behind", async () => {
      await planted(
        "I5",
        () => sql("CREATE POLICY inv_probe_insert ON tenants FOR INSERT WITH CHECK (true)"),
        () => sql("DROP POLICY IF EXISTS inv_probe_insert ON tenants"),
        { "policy_off:tenants": 1, insert_not_refused: 1 },
      );
      expect(await rows("SELECT 1 FROM tenants WHERE slug = 'rls-probe'")).toEqual([]);
    });

    it("catches a side door: a table outside public, a view and a definer function", async () => {
      await planted(
        "I5",
        () =>
          admin.withoutTenant(async (q) => {
            await q.execute("CREATE TABLE ops.inv_probe_side (id integer PRIMARY KEY)");
            await q.execute("CREATE VIEW public.inv_probe_view AS SELECT id FROM drivers");
            await q.execute(
              "CREATE FUNCTION public.inv_probe_peek() RETURNS bigint LANGUAGE sql SECURITY DEFINER AS 'SELECT count(*) FROM drivers'",
            );
          }),
        () =>
          admin.withoutTenant(async (q) => {
            await q.execute("DROP FUNCTION IF EXISTS public.inv_probe_peek()");
            await q.execute("DROP VIEW IF EXISTS public.inv_probe_view");
            await q.execute("DROP TABLE IF EXISTS ops.inv_probe_side");
          }),
        { "global_table_unexpected:ops.inv_probe_side": 1, view_present: 1, definer_function: 1 },
      );
    });
  });

  // The checks judge in SQL aggregates (a Data API response holds at most 1 MiB), so each count
  // must mean exactly what the per-record judgment counted before. Each test plants every kind of
  // bad row its check knows at once, lifting a schema rule where the schema itself would refuse
  // the row, and expects the exact result: every category and every count. Undo takes the plants
  // out (last first) and puts every rule back as it was; then all five pass again.
  describe("aggregates count what the per-record reads counted", () => {
    type Undo = () => Promise<unknown>;

    async function lift(table: string, name: string): Promise<Undo> {
      const [c] = await rows<{ def: string }>(
        "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = CAST($1 AS regclass) AND conname = $2",
        [table, name],
      );
      if (!c) throw new Error(`fixture: no constraint ${name}`);
      await sql(`ALTER TABLE ${table} DROP CONSTRAINT ${name}`);
      return () => sql(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${c.def}`);
    }

    async function liftIndex(name: string): Promise<Undo> {
      const [i] = await rows<{ def: string }>("SELECT pg_get_indexdef(CAST($1 AS regclass)) AS def", [name]);
      await sql(`DROP INDEX ${name}`);
      return () => sql(i.def);
    }

    async function liftNotNull(table: string, column: string): Promise<Undo> {
      await sql(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP NOT NULL`);
      return () => sql(`ALTER TABLE ${table} ALTER COLUMN ${column} SET NOT NULL`);
    }

    // A payment-channel ledger row, taken as far as `end`. by: the proposer (null for none).
    type Action = {
      tenant: string;
      kind: "advance_payout" | "settlement_payout";
      subject: string;
      attempt?: number;
      amount: number;
      outside?: number | null;
      driver: string;
      by?: string | null;
      proposal?: string | null;
      approver: string;
      end: "reserved" | "confirmed" | "refused";
    };
    async function plantAction(a: Action): Promise<Undo> {
      const id = randomUUID();
      const attempt = a.attempt ?? 1;
      await admin.withoutTenant(async (q) => {
        await q.execute(
          `INSERT INTO money_actions (id, tenant_id, kind, channel, subject_table, subject_id, attempt,
             idempotency_key, request_id, amount_cents, counterparty_table, counterparty_id, proposed_by,
             proposal_id, approver_membership_id)
           VALUES (CAST($1 AS uuid), CAST($2 AS uuid), $3, 'payment', $4, CAST($5 AS uuid), $6, $7, $8, $9,
             'drivers', CAST($10 AS uuid), $11, CAST($12 AS uuid), CAST($13 AS uuid))`,
          [
            id,
            a.tenant,
            a.kind,
            a.kind === "advance_payout" ? "advances" : "settlements",
            a.subject,
            attempt,
            `${a.kind}:${a.subject}:${attempt}`,
            id.replace(/-/g, ""),
            a.amount,
            a.driver,
            a.by === undefined ? "person" : a.by,
            a.proposal ?? null,
            a.approver,
          ],
        );
        if (a.end === "confirmed") {
          await q.execute("UPDATE money_actions SET state = 'sent', sent_at = now() WHERE id = CAST($1 AS uuid)", [id]);
          await q.execute(
            `UPDATE money_actions SET state = 'confirmed', settled_via = 'response', settled_at = now(),
               outside_system = 'mock', outside_type = 'payout', outside_id = 'po_test', outside_amount_cents = $2
             WHERE id = CAST($1 AS uuid)`,
            [id, a.outside === undefined ? a.amount : a.outside],
          );
        } else if (a.end === "refused") {
          await q.execute(
            `UPDATE money_actions SET state = 'failed', settled_via = 'refused', settled_at = now(),
               failure_category = 'disabled'
             WHERE id = CAST($1 AS uuid)`,
            [id],
          );
        }
      });
      return () => sql("DELETE FROM money_actions WHERE id = CAST($1 AS uuid)", [id]);
    }

    async function undoAll(undo: Undo[]): Promise<void> {
      for (const u of undo.reverse()) await u();
    }

    it("I1: every kind of bad row, the NULL ones included, counted as before", async () => {
      const base = (await expectAllPass()).I1;
      const [c0, c1] = carriers;
      const [other] = await rows<{ id: string }>(
        `SELECT CAST(id AS text) AS id FROM drivers WHERE tenant_id = CAST($1 AS uuid) AND id <> CAST($2 AS uuid)
          ORDER BY id LIMIT 1`,
        [c1.id, c1.settlement.driver],
      );
      const [outsideRule] = await rows<{ name: string }>(
        `SELECT conname AS name FROM pg_constraint
          WHERE conrelid = CAST('money_actions' AS regclass) AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%outside_amount_cents = amount_cents%'`,
      );
      const [pa] = await rows<{ id: string }>(
        `SELECT CAST(pa.id AS text) AS id FROM payment_applications pa
           JOIN customer_payments p ON p.tenant_id = pa.tenant_id AND p.id = pa.payment_id
           JOIN invoices i ON i.tenant_id = pa.tenant_id AND i.id = pa.invoice_id
          WHERE i.status = 'paid' AND i.id <> CAST($1 AS uuid)
            AND p.amount_cents = (SELECT sum(x.amount_cents) FROM payment_applications x
                                   WHERE x.tenant_id = p.tenant_id AND x.payment_id = p.id)
          ORDER BY pa.id LIMIT 1`,
        [c1.invoice.id],
      );
      expect([other, outsideRule, pa].every(Boolean)).toBe(true);

      const undo: Undo[] = [];
      try {
        // A settlement's net a cent off its lines.
        await sql("UPDATE settlements SET net_cents = net_cents + 1 WHERE id = CAST($1 AS uuid)", [c0.settlement.id]);
        undo.push(() => sql("UPDATE settlements SET net_cents = net_cents - 1 WHERE id = CAST($1 AS uuid)", [c0.settlement.id]));
        // A line of a kind the check does not know, worth nothing (the schema refuses the kind).
        undo.push(await lift("settlement_lines", "settlement_lines_kind_check"));
        const line = randomUUID();
        await sql(
          `INSERT INTO settlement_lines (id, tenant_id, settlement_id, seq, kind, label, amount_cents, sources)
           SELECT CAST($1 AS uuid), s.tenant_id, s.id,
                  (SELECT max(l.seq) + 1 FROM settlement_lines l WHERE l.tenant_id = s.tenant_id AND l.settlement_id = s.id),
                  'bonus', 'Bonus', 0, CAST('[]' AS jsonb)
             FROM settlements s WHERE s.id = CAST($2 AS uuid)`,
          [line, c1.settlement.id],
        );
        undo.push(() => sql("DELETE FROM settlement_lines WHERE id = CAST($1 AS uuid)", [line]));
        // An advance's recovered amount a cent short of its recovery lines.
        await sql("UPDATE advances SET recovered_cents = recovered_cents - 1 WHERE id = CAST($1 AS uuid)", [c1.advance.id]);
        undo.push(() => sql("UPDATE advances SET recovered_cents = recovered_cents + 1 WHERE id = CAST($1 AS uuid)", [c1.advance.id]));
        // A confirmed payout of the week's net to another driver.
        undo.push(
          await plantAction({
            tenant: c1.id,
            kind: "settlement_payout",
            subject: c1.settlement.id,
            amount: c1.settlement.net,
            driver: other.id,
            approver: c1.membership,
            end: "confirmed",
          }),
        );
        // A confirmed payout whose advance does not exist: its own category, never a mismatch.
        undo.push(
          await plantAction({
            tenant: c0.id,
            kind: "advance_payout",
            subject: randomUUID(),
            amount: 10000,
            driver: c0.driver,
            approver: c0.membership,
            end: "confirmed",
          }),
        );
        // A confirmed payout of the right amount to the right driver with no outside amount: a
        // mismatch (the schema refuses it).
        undo.push(await lift("money_actions", outsideRule.name));
        undo.push(
          await plantAction({
            tenant: c0.id,
            kind: "settlement_payout",
            subject: c0.settlement.id,
            amount: c0.settlement.net + 1,
            outside: null,
            driver: c0.settlement.driver,
            approver: c0.membership,
            end: "confirmed",
          }),
        );
        // A customer payment applied for more than it brought in.
        await sql("UPDATE payment_applications SET amount_cents = amount_cents + 100 WHERE id = CAST($1 AS uuid)", [pa.id]);
        undo.push(() => sql("UPDATE payment_applications SET amount_cents = amount_cents - 100 WHERE id = CAST($1 AS uuid)", [pa.id]));
        // A paid invoice marked open.
        await sql("UPDATE invoices SET status = 'open', paid_on = NULL WHERE id = CAST($1 AS uuid)", [c1.invoice.id]);
        undo.push(() =>
          sql("UPDATE invoices SET status = 'paid', paid_on = CAST($2 AS date) WHERE id = CAST($1 AS uuid)", [
            c1.invoice.id,
            c1.invoice.paidOn,
          ]),
        );

        const r = byId(await run()).I1;
        expect({ verdict: r.verdict, violations: r.violations, unknown: r.unknown, counts: r.counts }).toEqual({
          verdict: "FAIL",
          violations: {
            settlement_totals_off: 1,
            settlement_line_kind_unknown: 1,
            recovery_off: 1,
            payout_mismatch: 2,
            payout_subject_missing: 1,
            payment_overapplied: 1,
            invoice_status_off: 1,
          },
          unknown: [],
          counts: { ...base.counts, lines: base.counts.lines + 1, payouts: base.counts.payouts + 3 },
        });
      } finally {
        await undoAll(undo);
      }
      await expectAllPass();
    });

    it("I3: every kind of bad row, the NULL ones included, counted as before", async () => {
      const base = (await expectAllPass()).I3;
      const [c0, c1] = carriers;
      // Two more paid weeks of the first carrier with no ledger rows (seeded history).
      const weeks = await rows<{ id: string; net: number; driver: string; paidAt: string }>(
        `SELECT CAST(s.id AS text) AS id, s.net_cents AS net, CAST(s.driver_id AS text) AS driver,
                CAST(s.paid_at AS text) AS "paidAt"
           FROM settlements s
          WHERE s.tenant_id = CAST($1 AS uuid) AND s.status = 'paid' AND s.net_cents > 0 AND s.id <> CAST($2 AS uuid)
            AND NOT EXISTS (SELECT 1 FROM money_actions m WHERE m.tenant_id = s.tenant_id AND m.subject_id = s.id)
          ORDER BY s.id LIMIT 2`,
        [c0.id, c0.settlement.id],
      );
      const [adv] = await rows<{ amount: number; driver: string }>(
        "SELECT amount_cents AS amount, CAST(driver_id AS text) AS driver FROM advances WHERE id = CAST($1 AS uuid)",
        [c1.advance.id],
      );
      expect(weeks).toHaveLength(2);
      const [unmarked, unpaid] = weeks;

      const undo: Undo[] = [];
      try {
        // Rules the schema keeps, lifted so the rows the check exists to catch can be planted.
        undo.push(await liftIndex("money_actions_one_live_per_subject"));
        undo.push(await lift("money_actions", "money_actions_tenant_id_approver_membership_id_fkey"));
        undo.push(await lift("money_actions", "money_actions_proposal_fk"));
        undo.push(await lift("money_actions", "money_actions_proposed_by_check"));
        undo.push(await liftNotNull("money_actions", "proposed_by"));
        undo.push(await lift("proposals", "proposals_tenant_id_money_action_id_fkey"));
        undo.push(await liftNotNull("proposals", "status"));

        // A seeded paid advance that no longer reads as seeded: paid without a payout.
        await sql("UPDATE advances SET source = 'ui' WHERE id = CAST($1 AS uuid)", [c0.advance.id]);
        undo.push(() => sql("UPDATE advances SET source = 'seed' WHERE id = CAST($1 AS uuid)", [c0.advance.id]));
        // Two confirmed payouts on an advance outside the flow: paid twice, and off the flow.
        for (const attempt of [1, 2]) {
          undo.push(
            await plantAction({
              tenant: c1.id,
              kind: "advance_payout",
              subject: c1.advance.id,
              attempt,
              amount: adv.amount,
              driver: adv.driver,
              approver: c1.membership,
              end: "confirmed",
            }),
          );
        }
        // Two confirmed payouts on one week: paid twice.
        for (const attempt of [1, 2]) {
          undo.push(
            await plantAction({
              tenant: c1.id,
              kind: "settlement_payout",
              subject: c1.settlement.id,
              attempt,
              amount: c1.settlement.net,
              driver: c1.settlement.driver,
              approver: c1.membership,
              end: "confirmed",
            }),
          );
        }
        // A week paid out but not marked paid.
        await sql("UPDATE settlements SET status = 'approved', paid_at = NULL WHERE id = CAST($1 AS uuid)", [unmarked.id]);
        undo.push(() =>
          sql("UPDATE settlements SET status = 'paid', paid_at = CAST($2 AS timestamptz) WHERE id = CAST($1 AS uuid)", [
            unmarked.id,
            unmarked.paidAt,
          ]),
        );
        undo.push(
          await plantAction({
            tenant: c0.id,
            kind: "settlement_payout",
            subject: unmarked.id,
            amount: unmarked.net,
            driver: unmarked.driver,
            approver: c0.membership,
            end: "confirmed",
          }),
        );
        // A paid week whose only ledger row was refused: paid without a payout.
        undo.push(
          await plantAction({
            tenant: c0.id,
            kind: "settlement_payout",
            subject: unpaid.id,
            amount: unpaid.net,
            driver: unpaid.driver,
            approver: c0.membership,
            end: "refused",
          }),
        );
        // An agent's row that names no proposal.
        undo.push(
          await plantAction({
            tenant: c0.id,
            kind: "advance_payout",
            subject: randomUUID(),
            amount: 100,
            driver: c0.driver,
            by: "agent",
            approver: c0.membership,
            end: "reserved",
          }),
        );
        // An agent's row on a proposal nobody decided, which is not the advance's own.
        undo.push(
          await plantAction({
            tenant: c1.id,
            kind: "advance_payout",
            subject: c1.advance.id,
            attempt: 3,
            amount: adv.amount,
            driver: adv.driver,
            by: "agent",
            proposal: ids.proposals[1],
            approver: c1.membership,
            end: "reserved",
          }),
        );
        // A payout sent an hour before its proposal was decided.
        const early = payoutSentEarly("1 hour");
        await early.plant();
        undo.push(early.undo);
        // A row whose approver is not a member.
        undo.push(
          await plantAction({
            tenant: c0.id,
            kind: "settlement_payout",
            subject: randomUUID(),
            amount: 100,
            driver: c0.driver,
            approver: randomUUID(),
            end: "reserved",
          }),
        );
        // Rows whose proposer is neither the agent nor a person, one of them NULL.
        for (const by of ["robot", null]) {
          undo.push(
            await plantAction({
              tenant: c0.id,
              kind: "advance_payout",
              subject: randomUUID(),
              amount: 100,
              driver: c0.driver,
              by,
              approver: c0.membership,
              end: "reserved",
            }),
          );
        }
        // An agent's row naming a proposal that does not exist.
        undo.push(
          await plantAction({
            tenant: c0.id,
            kind: "advance_payout",
            subject: randomUUID(),
            amount: 100,
            driver: c0.driver,
            by: "agent",
            proposal: randomUUID(),
            approver: c0.membership,
            end: "reserved",
          }),
        );
        // A proposal with no status that names a ledger row that does not exist, and an agent's
        // row naming it (a NULL status reads as missing).
        const nullStatus = randomUUID();
        await sql(
          `INSERT INTO proposals (id, tenant_id, conversation_id, turn_id, kind, subject_table, subject_id,
             amount_cents, direction, title, args, operator_verdict, gateway_decision_id, dedupe_key, trace_id,
             status, money_action_id)
           SELECT CAST($1 AS uuid), tenant_id, conversation_id, turn_id, kind, subject_table, subject_id,
                  amount_cents, direction, title, args, operator_verdict, gateway_decision_id, $3, trace_id,
                  NULL, CAST($4 AS uuid)
             FROM proposals WHERE id = CAST($2 AS uuid)`,
          [nullStatus, ids.proposals[0], `advance_payout:${c0.driver}:${randomBytes(32).toString("hex")}`, randomUUID()],
        );
        undo.push(() => sql("DELETE FROM proposals WHERE id = CAST($1 AS uuid)", [nullStatus]));
        undo.push(
          await plantAction({
            tenant: c0.id,
            kind: "advance_payout",
            subject: randomUUID(),
            amount: 100,
            driver: c0.driver,
            by: "agent",
            proposal: nullStatus,
            approver: c0.membership,
            end: "reserved",
          }),
        );
        // A proposal that names a ledger row before anyone approved it.
        await sql("UPDATE proposals SET money_action_id = CAST($2 AS uuid) WHERE id = CAST($1 AS uuid)", [
          ids.proposals[0],
          ids.accountingRows[0],
        ]);
        undo.push(() => sql("UPDATE proposals SET money_action_id = NULL WHERE id = CAST($1 AS uuid)", [ids.proposals[0]]));

        const r = byId(await run()).I3;
        expect({ verdict: r.verdict, violations: r.violations, unknown: r.unknown, counts: r.counts }).toEqual({
          verdict: "FAIL",
          violations: {
            advance_paid_twice: 1,
            advance_paid_without_payout: 1,
            advance_payout_off_flow: 1,
            settlement_paid_twice: 1,
            settlement_payout_unmarked: 1,
            settlement_paid_without_payout: 1,
            approver_missing: 1,
            agent_payout_without_proposal: 1,
            proposer_unknown: 2,
            proposal_missing: 2,
            proposal_not_approved: 1,
            proposal_undecided: 1,
            proposal_mismatch: 1,
            sent_before_decision: 1,
            proposal_linked_early: 2,
            proposal_action_missing: 1,
          },
          unknown: [],
          counts: {
            ...base.counts,
            payment_rows: base.counts.payment_rows + 14,
            linked_proposals: (base.counts.linked_proposals ?? 0) + 2,
            // The two advances, the twice-paid week, the unmarked week, the refused week and the
            // week paid early are no longer seeded history.
            history_paid: base.counts.history_paid - 6,
          },
        });
      } finally {
        await undoAll(undo);
      }
      await expectAllPass();
    });

    it("pages every invoice exactly once, in key order, at any page size", async () => {
      const sqls = { first: INVOICES_FIRST_SQL, after: INVOICES_AFTER_SQL };
      const read = (size: number) =>
        readAll(admin, (q) => readPaged<InvoiceRow>(q, sqls, size, 10_000)).then((list) =>
          list.map((i) => [i.page_tenant, i.page_id, i.status, i.amount, i.has_paid_on, i.applied]),
        );
      const keys = await rows<{ t: string; id: string }>(
        "SELECT CAST(tenant_id AS text) AS t, CAST(id AS text) AS id FROM invoices ORDER BY tenant_id, id",
      );
      const all = await read(keys.length + 1);
      expect(all.map(([t, id]) => [t, id])).toEqual(keys.map((k) => [k.t, k.id]));
      for (const size of [7, 250, keys.length - 1, keys.length]) expect(await read(size)).toEqual(all);
    });
  });

  describe("read-only reads", () => {
    it("a write inside a check's transaction is refused by the database itself", async () => {
      const write = "UPDATE settlements SET net_cents = net_cents WHERE false";
      await expect(
        admin.withoutTenant(async (q) => {
          await q.execute(READ_ONLY_SNAPSHOT_SQL);
          await q.execute(write);
        }),
      ).rejects.toMatchObject({ name: "DbError", sqlState: "25006" });
      await expect(
        app.withTenant(carriers[0].id, async (q) => {
          await q.execute(READ_ONLY_SQL);
          await q.execute(write);
        }),
      ).rejects.toMatchObject({ name: "DbError", sqlState: "25006" });
    });
  });

  describe("npm run invariants", () => {
    const cli = (extra: string[] = []) =>
      spawnSync(join(process.cwd(), "node_modules", ".bin", "tsx"), ["scripts/invariants.ts", "--target", "local", ...extra], {
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: url.toString() },
      });

    // Nothing in the output may identify a row or a person: no ids, no emails, no amounts with cents.
    const hygienic = (text: string) => {
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      expect(text).not.toContain("@");
      expect(text).not.toMatch(/\$\s?[0-9]/);
    };

    it("exits 0 with five PASS lines on a clean database, and writes the same to JSON", async () => {
      const dir = mkdtempSync(join(tmpdir(), "invariants-"));
      try {
        const out = cli(["--json", join(dir, "run.json")]);
        expect(out.status).toBe(0);
        const lines = out.stdout.trim().split("\n");
        expect(lines).toHaveLength(5);
        lines.forEach((line, i) => {
          expect(line.startsWith(`I${i + 1} `)).toBe(true);
          expect(line).toMatch(/^I\d [a-z ]+: PASS \(/);
        });
        hygienic(out.stdout + out.stderr);
        const report = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
        expect(report.exitCode).toBe(0);
        expect(report.target).toBe("local");
        expect(report.results.map((r: InvariantResult) => r.verdict)).toEqual(["PASS", "PASS", "PASS", "PASS", "PASS"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("exits 1 and names the category, and nothing else, when a check fails", async () => {
      const s = carriers[0].settlement.id;
      await sql("UPDATE settlements SET net_cents = net_cents + 1 WHERE id = CAST($1 AS uuid)", [s]);
      try {
        const out = cli();
        expect(out.status).toBe(1);
        expect(out.stdout).toMatch(/^I1 ledger: FAIL \(settlement_totals_off 1; settlements \d+/m);
        hygienic(out.stdout + out.stderr);
      } finally {
        await sql("UPDATE settlements SET net_cents = net_cents - 1 WHERE id = CAST($1 AS uuid)", [s]);
      }
      expect(cli().status).toBe(0);
    });

    it("exits 1 on a usage error or a remote database, before reading anything", () => {
      const usage = spawnSync(join(process.cwd(), "node_modules", ".bin", "tsx"), ["scripts/invariants.ts"], {
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: url.toString() },
      });
      expect(usage.status).toBe(1);
      expect(usage.stderr).toContain("usage:");
      const remote = spawnSync(join(process.cwd(), "node_modules", ".bin", "tsx"), ["scripts/invariants.ts", "--target", "local"], {
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: "postgresql://someone@db.example.com:5432/payday" },
      });
      expect(remote.status).toBe(1);
      expect(remote.stderr).toContain("must point at a database on this machine");
      expect(remote.stdout).toBe("");
    });
  });
});
