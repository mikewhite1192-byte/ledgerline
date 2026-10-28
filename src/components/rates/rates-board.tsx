"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type ReactNode } from "react";
import { ConfirmPanel } from "@/components/app/confirm-panel";
import { EmptyState } from "@/components/app/states";
import { Term } from "@/components/app/term";
import { postJson } from "@/components/invoices/post-json";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/inline-alert";
import { Input } from "@/components/ui/input";
import { formatLocalDate } from "@/lib/format/dates";
import type { RateKind } from "@/lib/rates/candidates";
import { parseRate, perGallonText } from "@/lib/rates/format";
import type { RateSlot, RatesPage, RateView } from "@/lib/rates/read";
import { lookupNotice, lookupsLeftLine, pinNext, pinNotice, pinQuestion, RATES_WORDS as W } from "@/lib/rates/words";
import { addDays } from "@/lib/time/local-date";
import { Fuel } from "lucide-react";

// The Fuel and tax rates page's working part (GROUNDED-RATES design 4.8): the diesel price and one
// row per state, each with its pinned rate, the latest lookup when it is newer, and the buttons.
// Looking a rate up keeps a suggestion; only an admin pins one, through the confirm. Every word is
// a fixed sentence from words.ts; a lost answer says the outcome is not known. After each action
// the page reads itself back from the server.

type Notice = { at: string; tone: "success" | "info" | "warning" | "destructive"; text: string };

const slotKey = (kind: RateKind, state: string | null) => `${kind}:${state ?? "--"}`;

function day(value: string | null): string {
  if (!value) return "";
  try {
    return formatLocalDate(value);
  } catch {
    return "";
  }
}

function SourceLink({ view }: { view: RateView }) {
  const name = view.sourceTitle ?? (view.sourceHost || "the source page");
  return (
    <a
      href={view.sourceUrl}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="break-words text-link underline-offset-4 hover:underline"
    >
      {name}
    </a>
  );
}

function PinnedLine({ view }: { view: RateView }) {
  const who = view.byYou ? "you" : "an admin";
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-body text-foreground">
          <span className="font-semibold">{view.perGallon} per gallon</span>, pinned {day(view.pinnedOn)} by {who}, from{" "}
          <SourceLink view={view} />
        </p>
        <Badge tone={view.typed ? "neutral" : "success"}>{view.typed ? `Typed by ${who}` : "Confirmed from the source"}</Badge>
      </div>
      <p className="text-small text-foreground-2">Your rate rules use it from {day(view.effectiveFrom)}.</p>
    </div>
  );
}

function DayField({ id, today, value, onChange }: { id: string; today: string; value: string; onChange: (v: string) => void }) {
  const min = addDays(today, -366);
  const max = addDays(today, 31);
  const bad = value === "" || value < min || value > max;
  return (
    <Field id={id} label={W.fromLabel} hint={W.fromHint} error={bad ? W.fromBad : undefined}>
      {(p) => <Input {...p} type="date" min={min} max={max} value={value} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  );
}

function dayOk(value: string, today: string): boolean {
  return value !== "" && value >= addDays(today, -366) && value <= addDays(today, 31);
}

// A lookup's result, waiting for an admin: the figure and the words it was matched in, or, when
// the number could not be matched, the page to open and the typed path.
function Suggestion({
  view,
  canPin,
  today,
  pending,
  onPin,
  onType,
}: {
  view: RateView;
  canPin: boolean;
  today: string;
  pending: boolean;
  onPin: (from: string) => void;
  onType: () => void;
}) {
  const id = useId();
  const [from, setFrom] = useState(today);
  const [confirming, setConfirming] = useState(false);
  const matched = view.status === "suggested" && view.perGallon !== null;
  return (
    <div className="grid gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-small font-medium text-foreground-2">Latest lookup</p>
        <Badge tone={matched ? "success" : "warning"}>{matched ? W.matched : W.notMatched}</Badge>
      </div>
      {matched ? (
        <>
          <p className="text-h3 text-foreground">{view.perGallon} per gallon</p>
          {view.quote ? (
            <blockquote className="border-l-2 border-border pl-3 text-body break-words text-foreground-2">
              &ldquo;{view.quote}&rdquo;
            </blockquote>
          ) : null}
          <p className="text-small text-foreground-2">
            {view.asOf ? <>Dated {day(view.asOf)} on the page. </> : null}From <SourceLink view={view} />
          </p>
        </>
      ) : (
        <>
          <p className="text-body text-foreground-2">{W.notMatchedBody}</p>
          <p className="text-small text-foreground-2">
            Page: <SourceLink view={view} />
          </p>
        </>
      )}
      {!canPin ? (
        <p className="text-small text-foreground-2">{W.onlyAdmin}</p>
      ) : matched ? (
        confirming ? (
          <ConfirmPanel
            question={pinQuestion(view.perGallon as string)}
            next={pinNext(day(from))}
            confirmLabel={W.pinThis}
            pending={pending}
            pendingLabel={W.pinning}
            onConfirm={() => onPin(from)}
            onCancel={() => setConfirming(false)}
          />
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <DayField id={`${id}-from`} today={today} value={from} onChange={setFrom} />
            <Button variant="outline" disabled={!dayOk(from, today)} onClick={() => setConfirming(true)}>
              {W.pinThis}
            </Button>
          </div>
        )
      ) : (
        <div>
          <Button variant="outline" onClick={onType}>
            {W.typeIt}
          </Button>
        </div>
      )}
    </div>
  );
}

// An admin types the rate from a page they link, then confirms it.
function TypedForm({
  kind,
  defaultUrl,
  today,
  pending,
  onPin,
  onCancel,
}: {
  kind: RateKind;
  defaultUrl: string;
  today: string;
  pending: boolean;
  onPin: (rate: string, url: string, from: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [rate, setRate] = useState("");
  const [url, setUrl] = useState(defaultUrl);
  const [from, setFrom] = useState(today);
  const [tried, setTried] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const value = parseRate(rate);
  const rateOk = value !== null && value > 0;
  const urlOk = /^https:\/\/[^\s/]+\.[^\s]+$/.test(url.trim()) && url.trim().length <= 2000;
  const ok = rateOk && urlOk && dayOk(from, today);
  if (confirming && value !== null) {
    return (
      <ConfirmPanel
        question={pinQuestion(perGallonText(kind, value))}
        next={pinNext(day(from))}
        confirmLabel={W.pinThis}
        pending={pending}
        pendingLabel={W.pinning}
        onConfirm={() => onPin(rate.trim(), url.trim(), from)}
        onCancel={() => setConfirming(false)}
      />
    );
  }
  return (
    <form
      className="grid gap-3 rounded-lg border border-border bg-card px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (ok) setConfirming(true);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${id}-rate`} label={W.rateLabel} hint={W.rateHint} error={tried && !rateOk ? W.rateBad : undefined}>
          {(p) => <Input {...p} inputMode="decimal" autoComplete="off" value={rate} onChange={(e) => setRate(e.target.value)} />}
        </Field>
        <DayField id={`${id}-from`} today={today} value={from} onChange={setFrom} />
      </div>
      <Field id={`${id}-url`} label={W.pageLabel} hint={W.pageHint} error={tried && !urlOk ? W.pageBad : undefined}>
        {(p) => <Input {...p} type="url" autoComplete="off" value={url} onChange={(e) => setUrl(e.target.value)} />}
      </Field>
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onCancel}>
          {W.cancel}
        </Button>
        <Button type="submit" variant="outline">
          {W.review}
        </Button>
      </div>
    </form>
  );
}

function SlotNotice({ notice, at }: { notice: Notice | null; at: string }) {
  if (!notice || notice.at !== at) return null;
  return <InlineAlert tone={notice.tone}>{notice.text}</InlineAlert>;
}

export function RatesBoard({ page }: { page: RatesPage }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [typing, setTyping] = useState<string | null>(null);
  const noLookups = page.lookupsLeft <= 0;

  async function lookUp(kind: RateKind, state: string | null) {
    const at = slotKey(kind, state);
    setBusy(`lookup:${at}`);
    setNotice(null);
    const reply = await postJson("/api/rates/lookup", state === null ? { kind } : { kind, state });
    const status = reply.data.status;
    const outcome = reply.ok && (status === "suggested" || status === "unconfirmed") ? status : (reply.error ?? "unknown");
    setNotice({ at, ...lookupNotice(outcome) });
    setBusy(null);
    router.refresh();
  }

  async function pinSuggested(view: RateView, from: string) {
    const at = slotKey(view.kind, view.state);
    setBusy(`pin:${at}`);
    setNotice(null);
    const reply = await postJson(`/api/rates/${encodeURIComponent(view.id)}/pin`, { effectiveFrom: from });
    setNotice({ at, ...pinNotice(reply.ok ? "pinned" : (reply.error ?? "unknown")) });
    setBusy(null);
    router.refresh();
  }

  async function pinTyped(kind: RateKind, state: string | null, rate: string, sourceUrl: string, from: string) {
    const at = slotKey(kind, state);
    setBusy(`pin:${at}`);
    setNotice(null);
    const body = { kind, ...(state === null ? {} : { state }), rate, sourceUrl, effectiveFrom: from };
    const reply = await postJson("/api/rates/pin", body);
    const outcome = reply.ok ? (reply.data.already === true ? "already" : "pinned") : (reply.error ?? "unknown");
    setNotice({ at, ...pinNotice(outcome) });
    if (reply.ok) setTyping(null);
    setBusy(null);
    router.refresh();
  }

  // One rate's pinned line, its latest lookup and the typed path, for the diesel price or a state.
  function slotBody(kind: RateKind, state: string | null, slot: RateSlot, empty: ReactNode) {
    const at = slotKey(kind, state);
    const isTyping = typing === at;
    return (
      <div className="grid gap-3">
        <SlotNotice notice={notice} at={at} />
        {slot.pinned ? <PinnedLine view={slot.pinned} /> : empty}
        {slot.suggestion ? (
          <Suggestion
            key={slot.suggestion.id}
            view={slot.suggestion}
            canPin={page.canPin}
            today={page.today}
            pending={busy === `pin:${at}`}
            onPin={(from) => void pinSuggested(slot.suggestion as RateView, from)}
            onType={() => setTyping(at)}
          />
        ) : null}
        {isTyping ? (
          <TypedForm
            kind={kind}
            defaultUrl={slot.suggestion?.status === "unconfirmed" ? slot.suggestion.sourceUrl : ""}
            today={page.today}
            pending={busy === `pin:${at}`}
            onPin={(rate, url, from) => void pinTyped(kind, state, rate, url, from)}
            onCancel={() => setTyping(null)}
          />
        ) : page.canPin && slot.suggestion?.status !== "unconfirmed" ? (
          <div>
            <Button variant="link" size="sm" onClick={() => setTyping(at)}>
              {W.typeOwn}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  const nothingYet =
    !page.diesel.pinned && !page.diesel.suggestion && page.states.every((s) => !s.pinned && !s.suggestion);
  const dieselAt = slotKey("diesel_index", null);

  return (
    <div className="grid gap-6">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-4 py-4 sm:px-5">
          <div className="grid max-w-[60ch] gap-1">
            <h2 className="text-h3 text-foreground">{W.dieselTitle}</h2>
            <p className="text-body text-foreground-2">
              The weekly <Term id="diesel-index">diesel index</Term> your <Term id="fuel-surcharge">fuel surcharge</Term>{" "}
              follows.
            </p>
          </div>
          <div className="grid justify-items-start gap-1 sm:justify-items-end">
            <Button
              variant="primary"
              pending={busy === `lookup:${dieselAt}`}
              pendingLabel={W.lookingUp}
              disabled={busy !== null || noLookups}
              onClick={() => void lookUp("diesel_index", null)}
            >
              {W.lookUpDiesel}
            </Button>
            <p className="text-small text-foreground-2">{lookupsLeftLine(page.lookupsLeft)}</p>
          </div>
        </div>
        <div className="px-4 py-4 sm:px-5">
          {slotBody(
            "diesel_index",
            null,
            page.diesel,
            nothingYet ? (
              <EmptyState icon={<Fuel aria-hidden />} title={W.emptyTitle} body={W.emptyBody} className="py-6" />
            ) : (
              <p className="text-body text-foreground-2">{W.notPinned}</p>
            ),
          )}
        </div>
      </Card>

      <Card>
        <div className="grid gap-1 border-b border-border px-4 py-4 sm:px-5">
          <h2 className="text-h3 text-foreground">{W.statesTitle}</h2>
          <p className="max-w-[60ch] text-body text-foreground-2">
            The <Term id="fuel-tax-rate">fuel tax rate</Term> per gallon for each state your loads crossed.
          </p>
        </div>
        {page.states.length === 0 ? (
          <p className="px-4 py-4 text-body text-foreground-2 sm:px-5">{W.noStates}</p>
        ) : (
          <ul className="divide-y divide-border">
            {page.states.map((s) => {
              const at = slotKey("ifta_rate", s.code);
              return (
                <li key={s.code} className="grid gap-3 px-4 py-3 sm:px-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-body font-semibold text-foreground">{s.name}</h3>
                    <Button
                      variant="link"
                      size="sm"
                      pending={busy === `lookup:${at}`}
                      pendingLabel={W.lookingUp}
                      disabled={busy !== null || noLookups}
                      aria-label={`${W.lookUpState} the fuel tax rate for ${s.name}`}
                      onClick={() => void lookUp("ifta_rate", s.code)}
                    >
                      {W.lookUpState}
                    </Button>
                  </div>
                  {slotBody("ifta_rate", s.code, s, <p className="text-small text-foreground-2">{W.notPinned}</p>)}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
