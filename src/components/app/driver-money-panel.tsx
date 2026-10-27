"use client";

import { useId, useState, type FormEvent } from "react";
import { FuelCardChip } from "@/components/app/fuel-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/inline-alert";
import { controlClass, Input } from "@/components/ui/input";
import type { DriverIdentity, IdentityCard } from "@/lib/advances/identity";
import { panelSentence } from "@/lib/advances/reasons";
import { cn } from "@/lib/cn";
import { formatInstant } from "@/lib/format/dates";

// The driver's money panel: whether they are armed to receive money, the ids the dispatch system
// knows them by, and every fuel card on file with the default marked. Arming and the cards are an
// admin's; any member may add an id. Each press asks its route, which re-checks the role and the
// driver itself; onDone then lets the page read the driver again. Cards are shown by their last
// four and, for a generic card, the placeholder its portal shows. Test mode: nothing reaches a
// provider.

export type PanelSend = (path: string, body: Record<string, unknown>) => Promise<{ ok: boolean; error: string | null }>;

async function postJson(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; error: string | null }> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true, error: null };
    let error: unknown = null;
    try {
      error = ((await res.json()) as { error?: unknown }).error;
    } catch {
      error = null;
    }
    return { ok: false, error: typeof error === "string" ? error : "unavailable" };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

export function holderWords(card: Pick<IdentityCard, "holderKind" | "portalName">): string {
  if (card.holderKind === "generic") {
    return card.portalName ? `Generic card, portal name ${card.portalName}` : "Generic card";
  }
  return "In the driver's name";
}

type Pending = "arm" | "id" | "card" | `default:${string}` | `close:${string}`;

export function DriverMoneyPanel({
  identity,
  canAdmin,
  timezone,
  send = postJson,
  onDone,
}: {
  identity: DriverIdentity;
  canAdmin: boolean;
  timezone: string;
  send?: PanelSend;
  onDone?: () => void;
}) {
  const base = `/api/drivers/${encodeURIComponent(identity.driverId)}`;
  // Element ids from React, so two panels on one page (the design review shows four) never clash.
  const uid = useId();
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmArm, setConfirmArm] = useState(false);
  const [addingId, setAddingId] = useState(false);
  const [externalId, setExternalId] = useState("");
  const [addingCard, setAddingCard] = useState(false);
  const [last4, setLast4] = useState("");
  const [holderKind, setHolderKind] = useState<"named" | "generic">("named");
  const [portalName, setPortalName] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);
  const [errors, setErrors] = useState<{ externalId?: string; last4?: string; portalName?: string }>({});

  async function run(what: Pending, path: string, body: Record<string, unknown>, done: string): Promise<boolean> {
    if (pending) return false;
    setPending(what);
    setNotice(null);
    try {
      const out = await send(path, body);
      setNotice(out.ok ? { ok: true, text: done } : { ok: false, text: panelSentence(out.error ?? "unavailable") });
      return out.ok;
    } finally {
      setPending(null);
      onDone?.();
    }
  }

  async function arm() {
    const wanted = !identity.armed.on;
    const ok = await run("arm", `${base}/arm`, { armed: wanted }, wanted ? "Armed. Advances can be paid to this driver." : "Disarmed. Nothing will be paid to this driver until an admin arms them again.");
    if (ok) setConfirmArm(false);
  }

  async function addId(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = externalId.trim();
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(value)) {
      setErrors({ externalId: "Letters, digits, dots, dashes and underscores, up to 40." });
      return;
    }
    setErrors({});
    if (await run("id", `${base}/identities`, { system: "tms", externalId: value }, "Saved the dispatch id.")) {
      setExternalId("");
      setAddingId(false);
    }
  }

  async function addCard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const portal = portalName.trim().replace(/\s+/g, " ").toUpperCase();
    const next = {
      last4: /^[0-9]{4}$/.test(last4.trim()) ? undefined : "The card's last four digits.",
      portalName:
        holderKind === "named" || /^[A-Z0-9 -]{2,40}$/.test(portal)
          ? undefined
          : "Letters, digits, spaces and dashes, 2 to 40. Never a person's name.",
    };
    setErrors(next);
    if (next.last4 || next.portalName) return;
    const body: Record<string, unknown> = { last4: last4.trim(), holderKind, makeDefault };
    if (holderKind === "generic") body.portalName = portal;
    if (await run("card", `${base}/cards`, body, "Added the card, in test mode.")) {
      setLast4("");
      setPortalName("");
      setHolderKind("named");
      setMakeDefault(false);
      setAddingCard(false);
    }
  }

  const since = identity.armed.since ? formatInstant(identity.armed.since, timezone) : null;
  const busy = pending !== null;
  return (
    <Card>
      <CardHeader>
        <div className="grid gap-0.5">
          <CardTitle>Money</CardTitle>
          <CardDescription>Whether money may go to this driver, and where. Test mode: nothing reaches a card provider.</CardDescription>
        </div>
      </CardHeader>
      <CardBody className="grid gap-6">
        <section aria-labelledby={`${uid}-armed`} className="grid gap-3">
          <h3 id={`${uid}-armed`} className="text-small text-muted-foreground">
            Armed to receive money
          </h3>
          <div className="flex flex-wrap items-center gap-3">
            {identity.armed.on ? (
              <Badge tone="success">{since ? `Armed since ${since}` : "Armed"}</Badge>
            ) : (
              <Badge tone="warning">Not armed</Badge>
            )}
            {canAdmin && !confirmArm ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirmArm(true)}>
                {identity.armed.on ? "Disarm" : "Arm"}
              </Button>
            ) : null}
          </div>
          {canAdmin && confirmArm ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-body text-foreground">
                {identity.armed.on
                  ? `Disarm ${identity.name}? No advance can be paid to them until an admin arms them again.`
                  : `Arm ${identity.name}? Approved advances can then be paid to their default card.`}
              </p>
              <Button
                variant={identity.armed.on ? "destructive" : "primary"}
                size="sm"
                pending={pending === "arm"}
                pendingLabel={identity.armed.on ? "Disarming" : "Arming"}
                disabled={busy}
                onClick={arm}
              >
                {identity.armed.on ? "Disarm" : "Arm"}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmArm(false)}>
                Never mind
              </Button>
            </div>
          ) : null}
          {!canAdmin ? <p className="text-small text-muted-foreground">Only an admin arms or disarms a driver.</p> : null}
        </section>

        <section aria-labelledby={`${uid}-ids`} className="grid gap-3">
          <h3 id={`${uid}-ids`} className="text-small text-muted-foreground">
            Known as
          </h3>
          {identity.tmsIds.length === 0 ? (
            <p className="text-body text-foreground-2">No dispatch id on file.</p>
          ) : (
            <ul className="grid gap-1">
              {identity.tmsIds.map((t) => (
                <li key={t} className="text-body text-foreground">
                  Dispatch system: <span className="font-mono tabular-nums">{t}</span>
                </li>
              ))}
            </ul>
          )}
          {addingId ? (
            <form onSubmit={addId} noValidate className="flex flex-wrap items-end gap-2">
              <Field id={`${uid}-tms`} label="Dispatch id" error={errors.externalId} className="min-w-[12rem] flex-1">
                {(control) => (
                  <Input {...control} autoComplete="off" value={externalId} onChange={(e) => setExternalId(e.target.value)} disabled={busy} />
                )}
              </Field>
              <Button type="submit" size="md" pending={pending === "id"} pendingLabel="Saving" disabled={busy}>
                Save
              </Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setAddingId(false)}>
                Never mind
              </Button>
            </form>
          ) : (
            <div>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setAddingId(true)}>
                Add id
              </Button>
            </div>
          )}
        </section>

        <section aria-labelledby={`${uid}-cards`} className="grid gap-3">
          <h3 id={`${uid}-cards`} className="text-small text-muted-foreground">
            Cards on file
          </h3>
          {identity.cards.length === 0 ? (
            <p className="text-body text-foreground-2">No fuel card on file. An advance cannot be paid until one is added.</p>
          ) : (
            <ul className="grid gap-3">
              {identity.cards.map((c) => (
                <li key={c.id} className="grid gap-1.5 rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <FuelCardChip last4={c.last4} status={c.status} testMode={c.testMode} />
                    {c.isDefault ? <Badge tone="info">Default</Badge> : null}
                  </div>
                  <p className="text-small text-muted-foreground">{holderWords(c)}</p>
                  {canAdmin && c.status === "active" ? (
                    <div className="flex flex-wrap gap-2">
                      {!c.isDefault ? (
                        <Button
                          variant="outline"
                          size="sm"
                          pending={pending === `default:${c.id}`}
                          pendingLabel="Saving"
                          disabled={busy}
                          onClick={() => run(`default:${c.id}`, `${base}/cards/${encodeURIComponent(c.id)}/default`, {}, `Card ···· ${c.last4} is now the default.`)}
                        >
                          Make default
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        pending={pending === `close:${c.id}`}
                        pendingLabel="Closing"
                        disabled={busy}
                        onClick={() => run(`close:${c.id}`, `${base}/cards/${encodeURIComponent(c.id)}/close`, {}, `Closed card ···· ${c.last4}.`)}
                      >
                        Close
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {canAdmin ? (
            addingCard ? (
              <form onSubmit={addCard} noValidate className="grid gap-3 rounded-lg border border-border p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field id={`${uid}-last4`} label="Last four digits" error={errors.last4}>
                    {(control) => (
                      <Input
                        {...control}
                        inputMode="numeric"
                        autoComplete="off"
                        maxLength={4}
                        value={last4}
                        onChange={(e) => setLast4(e.target.value)}
                        disabled={busy}
                      />
                    )}
                  </Field>
                  <Field id={`${uid}-holder`} label="Card holder">
                    {(control) => (
                      <select
                        {...control}
                        value={holderKind}
                        onChange={(e) => setHolderKind(e.target.value === "generic" ? "generic" : "named")}
                        disabled={busy}
                        className={cn(controlClass, "h-9")}
                      >
                        <option value="named">In the driver&apos;s name</option>
                        <option value="generic">Generic card (pool or company)</option>
                      </select>
                    )}
                  </Field>
                </div>
                {holderKind === "generic" ? (
                  <Field
                    id={`${uid}-portal`}
                    label="Portal name"
                    hint="What the card portal shows, like POOL CARD 3."
                    error={errors.portalName}
                  >
                    {(control) => (
                      <Input {...control} autoComplete="off" value={portalName} onChange={(e) => setPortalName(e.target.value)} disabled={busy} />
                    )}
                  </Field>
                ) : null}
                <label className="flex items-center gap-2 text-body text-foreground">
                  <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} disabled={busy} className="size-4" />
                  Make it the default card
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" pending={pending === "card"} pendingLabel="Adding" disabled={busy}>
                    Add card
                  </Button>
                  <Button type="button" variant="ghost" disabled={busy} onClick={() => setAddingCard(false)}>
                    Never mind
                  </Button>
                </div>
              </form>
            ) : (
              <div>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => setAddingCard(true)}>
                  Add card
                </Button>
              </div>
            )
          ) : null}
        </section>

        {notice ? <InlineAlert tone={notice.ok ? "success" : "destructive"}>{notice.text}</InlineAlert> : null}
      </CardBody>
    </Card>
  );
}
