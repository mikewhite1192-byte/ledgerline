"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineAlert } from "@/components/ui/inline-alert";
import { controlClass } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { postJson } from "@/components/invoices/post-json";
import { MODE_LABELS, NEVER_ALONE_NOTE, NOT_ARMED_NOTE, RULE_SAVE_MESSAGES, messageFor, ruleKindLabel } from "./words";

// One kind's rule as the page hands it over: plain values, whole cents.
export type RuleRowView = {
  kind: string;
  mode: "off" | "ask" | "auto";
  allowedAuto: boolean;
  armed: boolean;
  // Whether the kind pays a driver, so it has a per-driver day limit.
  driver: boolean;
  maxCents: number;
  dayMaxCents: number;
  dayMaxCount: number;
  driverDayMaxCents: number | null;
  // The saved rule's version, or null when the kind has no rule yet.
  version: number | null;
};

type Draft = { mode: string; maxCents: string; dayMaxCents: string; dayMaxCount: string; driverDayMaxCents: string };

const draftOf = (r: RuleRowView): Draft => ({
  mode: r.mode,
  maxCents: String(r.maxCents),
  dayMaxCents: String(r.dayMaxCents),
  dayMaxCount: String(r.dayMaxCount),
  driverDayMaxCents: r.driverDayMaxCents === null ? "" : String(r.driverDayMaxCents),
});

// A whole number as typed, or NaN (the server refuses it and names the field).
const whole = (s: string): number => (/^\d{1,10}$/.test(s.trim()) ? Number(s.trim()) : Number.NaN);

const isMode = (v: unknown): v is RuleRowView["mode"] => v === "off" || v === "ask" || v === "auto";

// The rule the server answered with, read field by field; null when it does not read.
function savedOf(row: RuleRowView, value: unknown): RuleRowView | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : null);
  const maxCents = n(v.maxCents);
  const dayMaxCents = n(v.dayMaxCents);
  const dayMaxCount = n(v.dayMaxCount);
  const version = n(v.version);
  const driver = v.driverDayMaxCents === null ? null : n(v.driverDayMaxCents);
  if (!isMode(v.mode) || maxCents === null || dayMaxCents === null || dayMaxCount === null || version === null) return null;
  if (v.driverDayMaxCents !== null && driver === null) return null;
  return { ...row, mode: v.mode, maxCents, dayMaxCents, dayMaxCount, driverDayMaxCents: driver, version };
}

function RuleRow({ initial }: { initial: RuleRowView }) {
  const [row, setRow] = useState<RuleRowView>(initial);
  const [draft, setDraft] = useState<Draft>(draftOf(initial));
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<{ tone: "success" | "destructive"; text: string } | null>(null);
  const label = ruleKindLabel(row.kind);
  const set = (k: keyof Draft) => (e: { currentTarget: { value: string } }) => {
    const value = e.currentTarget.value;
    setDraft((d) => ({ ...d, [k]: value }));
  };

  async function save() {
    if (pending) return;
    setPending(true);
    setNote(null);
    const body: Record<string, unknown> = {
      kind: row.kind,
      mode: draft.mode,
      maxCents: whole(draft.maxCents),
      dayMaxCents: whole(draft.dayMaxCents),
      dayMaxCount: whole(draft.dayMaxCount),
      expectedVersion: row.version,
    };
    if (row.driver) body.driverDayMaxCents = whole(draft.driverDayMaxCents);
    const reply = await postJson("/api/autopilot/rules", body);
    const saved = savedOf(row, reply.data.rule);
    if (reply.ok && reply.error === null && saved) {
      setRow(saved);
      setDraft(draftOf(saved));
      setNote({ tone: "success", text: reply.data.unchanged === true ? "Nothing to change." : "Saved." });
    } else {
      // Out of date: show the rule as it is now, so the next save is on its version.
      if (reply.error === "changed" && saved) {
        setRow(saved);
        setDraft(draftOf(saved));
      }
      setNote({ tone: "destructive", text: messageFor(RULE_SAVE_MESSAGES, reply.error) });
    }
    setPending(false);
  }

  const input = cn(controlClass, "h-9 w-32");
  return (
    <form
      className="grid gap-2 border-b border-border py-3 last:border-b-0"
      aria-label={`${label} rule`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <span className="min-w-40 text-body font-medium text-foreground">{label}</span>
        <label className="grid gap-0.5 text-caption text-foreground-2">
          Rule
          <select name="mode" value={draft.mode} onChange={set("mode")} disabled={pending} className={input}>
            {(["off", "ask", "auto"] as const).map((m) => (
              <option key={m} value={m} disabled={m === "auto" && !row.allowedAuto}>
                {MODE_LABELS[m]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-0.5 text-caption text-foreground-2">
          Most each time, in cents
          <input name="maxCents" inputMode="numeric" value={draft.maxCents} onChange={set("maxCents")} disabled={pending} className={input} />
        </label>
        <label className="grid gap-0.5 text-caption text-foreground-2">
          Most each day, in cents
          <input name="dayMaxCents" inputMode="numeric" value={draft.dayMaxCents} onChange={set("dayMaxCents")} disabled={pending} className={input} />
        </label>
        <label className="grid gap-0.5 text-caption text-foreground-2">
          Most each day, count
          <input name="dayMaxCount" inputMode="numeric" value={draft.dayMaxCount} onChange={set("dayMaxCount")} disabled={pending} className={input} />
        </label>
        {row.driver ? (
          <label className="grid gap-0.5 text-caption text-foreground-2">
            Most per driver each day, in cents
            <input
              name="driverDayMaxCents"
              inputMode="numeric"
              value={draft.driverDayMaxCents}
              onChange={set("driverDayMaxCents")}
              disabled={pending}
              className={input}
            />
          </label>
        ) : null}
        <Button type="submit" variant="secondary" pending={pending} pendingLabel="Saving">
          Save
        </Button>
      </div>
      {!row.allowedAuto ? <p className="text-caption text-foreground-2">{NEVER_ALONE_NOTE}</p> : null}
      {row.allowedAuto && !row.armed && row.mode === "auto" ? <p className="text-caption text-foreground-2">{NOT_ARMED_NOTE}</p> : null}
      {note ? (
        <InlineAlert tone={note.tone} className="w-full">
          {note.text}
        </InlineAlert>
      ) : null}
    </form>
  );
}

// Every kind's rule, one small form each. A save changes only that kind; each is recorded. Each
// form is keyed by its kind and saved version, so a page refresh that brings a newer rule shows it.
export function AutopilotRulesForm({ rows }: { rows: RuleRowView[] }) {
  return (
    <div className="grid">
      {rows.map((r) => (
        <RuleRow key={`${r.kind}:${r.version ?? "none"}`} initial={r} />
      ))}
    </div>
  );
}
