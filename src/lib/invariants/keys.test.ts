import { describe, expect, it } from "vitest";
import { DUPLICATES_SQL, GUARDED_KEYS, judgeKeys, type KeyRows } from "./keys";

function clean(): KeyRows {
  const duplicates: Record<string, unknown> = { model_calls_upstream: 0 };
  for (const k of GUARDED_KEYS) duplicates[k.key] = 0;
  return {
    indexes: [
      ...GUARDED_KEYS.map((k) => ({ name: k.index, definition: k.definition, is_unique: true, is_valid: true, is_ready: true })),
      // Other indexes are not this check's business.
      { name: "drivers_pkey", definition: "CREATE UNIQUE INDEX drivers_pkey ON public.drivers USING btree (id)", is_unique: true, is_valid: true, is_ready: true },
    ],
    duplicates: [duplicates],
  };
}

describe("judgeKeys", () => {
  it("passes when every key's index is in place and no key repeats", () => {
    const r = judgeKeys(clean());
    expect(r.verdict).toBe("PASS");
    expect(r.counts).toEqual({ keys: GUARDED_KEYS.length + 1, indexes: GUARDED_KEYS.length });
  });

  it("guards the ledger's idempotency key and the one-live-row rule", () => {
    const names = GUARDED_KEYS.map((k) => k.index);
    expect(names).toContain("money_actions_tenant_id_idempotency_key_key");
    expect(names).toContain("money_actions_one_live_per_subject");
    expect(names).toContain("proposals_tenant_id_dedupe_key_key");
    expect(new Set(GUARDED_KEYS.map((k) => k.key)).size).toBe(GUARDED_KEYS.length);
  });

  it("catches a missing index", () => {
    const rows = clean();
    rows.indexes = rows.indexes.filter((i) => i.name !== "money_actions_one_live_per_subject");
    expect(judgeKeys(rows).violations).toEqual({ "index_missing:money_actions_one_live_per_subject": 1 });
  });

  it("catches an index that changed shape or stopped working", () => {
    const changes = [
      { definition: "CREATE UNIQUE INDEX money_actions_one_live_per_subject ON public.money_actions USING btree (tenant_id, kind, subject_id)" },
      { definition: "CREATE INDEX money_actions_one_live_per_subject ON public.money_actions USING btree (tenant_id, kind, subject_id) WHERE (state <> 'failed'::text)" },
      { is_unique: false },
      { is_valid: false },
      { is_ready: false },
    ];
    for (const change of changes) {
      const rows = clean();
      rows.indexes = rows.indexes.map((i) => (i.name === "money_actions_one_live_per_subject" ? { ...i, ...change } : i));
      expect(judgeKeys(rows).violations).toEqual({ "index_changed:money_actions_one_live_per_subject": 1 });
    }
  });

  it("ignores whitespace in the definition only", () => {
    const rows = clean();
    rows.indexes = rows.indexes.map((i) => ({ ...i, definition: `  ${String(i.definition).replace(/ /g, "  ")}\n` }));
    expect(judgeKeys(rows).verdict).toBe("PASS");
  });

  it("catches duplicated keys and a model call logged twice", () => {
    const rows = clean();
    rows.duplicates[0].money_actions_idempotency = 1;
    rows.duplicates[0].model_calls_upstream = "2";
    expect(judgeKeys(rows).violations).toEqual({
      "duplicate:money_actions_idempotency": 1,
      "duplicate:model_calls_upstream": 2,
    });
  });

  it("treats a missing or unreadable count as unread, never zero", () => {
    const missingRow = clean();
    missingRow.duplicates = [];
    expect(() => judgeKeys(missingRow)).toThrow("duplicates_unread");
    const missingKey = clean();
    delete missingKey.duplicates[0].proposals_dedupe;
    expect(() => judgeKeys(missingKey)).toThrow("not_whole");
    const odd = clean();
    odd.indexes[0] = { ...odd.indexes[0], is_valid: null };
    expect(() => judgeKeys(odd)).toThrow("not_boolean");
  });

  it("reads every key's duplicates in one statement, honoring each partial index", () => {
    for (const k of GUARDED_KEYS) expect(DUPLICATES_SQL).toContain(`AS ${k.key}`);
    expect(DUPLICATES_SQL).toContain("WHERE state <> 'failed'");
    expect(DUPLICATES_SQL).toContain("WHERE load_id IS NOT NULL");
  });
});
