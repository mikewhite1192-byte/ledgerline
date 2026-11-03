"use client";

import { ArrowUp, Check } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useAgentPanel } from "@/components/agent/panel-context";
import { TRUST_LINE } from "@/components/agent/words";
import { NEEDS_YOU_ANCHOR, TODAY_ANCHOR } from "@/components/app/anchors";
import { Money } from "@/components/app/money";
import { PanelHashLink } from "@/components/app/panel-hash-link";
import type { Suggestion } from "@/components/app/prompt-chips";
import { AskLink } from "@/components/app/top-bar";
import { NEEDS_YOU_UNREAD } from "@/components/app/needs-you";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import type { DoneLine } from "@/lib/feed/words";
import { formatClock } from "@/lib/format/dates";
import type { Loaded } from "@/lib/home/loaded";
import type { NeedsYouRow, NeedsYouView } from "@/lib/home/needs-you";
import type { TodayIntake } from "@/lib/home/today";
import { sweepOutcome } from "@/lib/sweep/words";
import type { SweepRunView } from "@/lib/sweep/view";
import { localDateOf, type LocalDate } from "@/lib/time/local-date";
import { Unavailable } from "./home-card";

// The simple Home (flags.simpleShape): three blocks, what the coworker finished today, at most
// three things that need a person, and an ask box. Every line comes from a read Home already makes;
// nothing here calls a model or writes anything, and no model name or model cost shows.

const LINK = "text-small text-link underline-offset-4 hover:underline";

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export const DID_TODAY_EMPTY = "Nothing finished yet today. I check the books all day, and each thing I finish shows here.";
export const DID_TODAY_UNREAD = "Could not read today's work. Nothing changed.";
export const NEEDS_YOU_NONE = "Nothing needs you right now.";

type Line = { key: string; time: string | null; words: string; href: string | null };

// The run's line, only when it started today in the carrier's zone.
function sweepLine(run: SweepRunView, today: LocalDate, timezone: string): Line | null {
  try {
    if (localDateOf(run.startedAt, timezone) !== today) return null;
    return { key: `sweep:${run.id}`, time: formatClock(run.startedAt, timezone), words: sweepOutcome(run, "home"), href: `/sweep/${run.id}` };
  } catch {
    return null;
  }
}

type Shown = { documents: boolean; voiceNotes: boolean; messages: boolean; notesPage: boolean };

// "Read 2 documents, 1 voice note and 1 message from drivers.", from the kinds whose pages are on.
// Nothing came in: no line. The tap goes to the first kind with a count.
function intakeLine(intake: TodayIntake, shown: Shown): Line | null {
  const kinds = [
    { n: shown.documents ? intake.documents : 0, words: ["document", "documents"], href: "/documents" },
    { n: shown.voiceNotes ? intake.voiceNotes : 0, words: ["voice note", "voice notes"], href: "/voice-notes" },
    { n: shown.messages ? intake.messages : 0, words: ["message", "messages"], href: shown.notesPage ? "/driver-notes" : null },
  ].filter((k) => k.n > 0);
  if (kinds.length === 0) return null;
  const parts = kinds.map((k) => plural(k.n, k.words[0], k.words[1]));
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  return { key: "intake", time: null, words: `Read ${list} from drivers.`, href: kinds[0].href };
}

export type DidTodayProps = {
  // null while the sweep is switched off; a value of null means no sweep has run.
  sweep: Loaded<SweepRunView | null> | null;
  // null while every kind of intake is switched off.
  intake: Loaded<TodayIntake> | null;
  shown: Shown;
  // null while the live feed is switched off.
  done: Loaded<DoneLine[]> | null;
  today: LocalDate;
  timezone: string;
};

function Tick() {
  return (
    <span aria-hidden className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-success-soft text-success">
      <Check className="size-3" strokeWidth={3} />
    </span>
  );
}

function Row({ line }: { line: Line }) {
  const body = (
    <>
      <Tick />
      <span className="min-w-0 flex-1 text-body text-foreground">{line.words}</span>
      {line.time ? <span className="shrink-0 text-small text-muted-foreground tabular-nums max-sm:hidden">{line.time}</span> : null}
    </>
  );
  const row = "flex items-start gap-3 px-4 py-2.5 sm:px-5";
  return (
    <li>
      {line.href ? (
        <Link href={line.href} className={cn(row, "transition-colors duration-150 hover:bg-accent")}>
          {body}
        </Link>
      ) : (
        <div className={row}>{body}</div>
      )}
    </li>
  );
}

function Block({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  const titleId = `${id ?? "ask-anything"}-title`;
  return (
    <section id={id} aria-labelledby={titleId} className="min-w-0 scroll-mt-28">
      <Card>
        <h2 id={titleId} className="px-4 pt-4 text-h3 text-foreground sm:px-5">
          {title}
        </h2>
        {children}
      </Card>
    </section>
  );
}

// What I did today: the pay check, what came in, then the money steps the coworker finished,
// oldest first, each with its time. One read failing drops only its lines; every read failing says
// so, never "nothing".
export function DidToday({ sweep, intake, shown, done, today, timezone }: DidTodayProps) {
  const reads = [sweep, intake, done].filter((r) => r !== null);
  const failed = reads.length > 0 && reads.every((r) => !r.ok);
  const lines: Line[] = [];
  if (sweep?.ok && sweep.value !== null) {
    const l = sweepLine(sweep.value, today, timezone);
    if (l) lines.push(l);
  }
  if (intake?.ok) {
    const l = intakeLine(intake.value, shown);
    if (l) lines.push(l);
  }
  if (done?.ok) lines.push(...done.value);
  return (
    <Block id={TODAY_ANCHOR} title="What I did today">
      {failed ? (
        <div className="px-4 pt-2 pb-4 sm:px-5">
          <Unavailable>{DID_TODAY_UNREAD}</Unavailable>
        </div>
      ) : lines.length === 0 ? (
        <p className="px-4 pt-1 pb-4 text-body text-foreground-2 sm:px-5">{DID_TODAY_EMPTY}</p>
      ) : (
        <>
          <ul aria-label="Done today" className="mt-1.5 pb-1">
            {lines.map((l) => (
              <Row key={l.key} line={l} />
            ))}
          </ul>
          {done ? (
            <div className="border-t border-border px-4 py-2.5 sm:px-5">
              <Link href="/activity" className={LINK}>
                See everything
              </Link>
            </div>
          ) : null}
        </>
      )}
    </Block>
  );
}

// The order rows are cut to three in: money a person pays out first, then this chat's cards, then
// billing, then the escalated asks.
const PRIORITY: readonly NeedsYouRow["key"][] = ["paystubs", "advances", "cards", "invoice_cards", "past_due", "escalated"];

const ROW_WORDS: Readonly<Record<NeedsYouRow["key"], [string, string]>> = {
  paystubs: ["paystub to approve", "paystubs to approve"],
  advances: ["advance request", "advance requests"],
  cards: ["card in your chat to approve", "cards in your chat to approve"],
  invoice_cards: ["invoice to approve", "invoices to approve"],
  past_due: ["invoice past due", "invoices past due"],
  escalated: ["request from your chat needs you", "requests from your chat need you"],
};

function rowWords(r: NeedsYouRow): string {
  const [one, many] = ROW_WORDS[r.key];
  const n = r.count.toLocaleString("en-US");
  // "or more" makes the count plural whatever its number.
  if (r.atLeast) return `${n} or more ${many}`;
  return `${n} ${r.count === 1 ? one : many}`;
}

// Where the cut rows live, from their links: Pay, Billing, or the chat.
const PLACES = ["on Pay", "on Billing", "in your chat"] as const;
function placeOf(href: string): (typeof PLACES)[number] {
  if (href.startsWith("/settlements") || href.startsWith("/advances")) return "on Pay";
  if (href.startsWith("/invoices")) return "on Billing";
  return "in your chat";
}

// "and 4 more on Billing" when the cut rows sit in one place; else the total, then each place's
// own count: "and 5 more: 4 on Billing, 1 in your chat".
function moreLine(cut: readonly NeedsYouRow[]): string {
  // A count that is only a floor reads "at least".
  const count = (rows: readonly NeedsYouRow[]) =>
    `${rows.some((r) => r.atLeast) ? "at least " : ""}${rows.reduce((s, r) => s + r.count, 0).toLocaleString("en-US")}`;
  const places = PLACES.map((place) => ({ place, rows: cut.filter((r) => placeOf(r.href) === place) })).filter(
    (p) => p.rows.length > 0,
  );
  if (places.length === 1) return `and ${count(cut)} more ${places[0].place}`;
  return `and ${count(cut)} more: ${places.map((p) => `${count(p.rows)} ${p.place}`).join(", ")}`;
}

function RowLink({ href, className, children }: { href: string; className: string; children: ReactNode }) {
  return href.startsWith("#") ? (
    <PanelHashLink href={href} className={className}>
      {children}
    </PanelHashLink>
  ) : (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

// Needs you: at most three rows, each one tap. The bell keeps counting every row. "Review", never
// "Approve": approving happens on the record, with its confirm step.
export function NeedsYouShort({ view }: { view: NeedsYouView }) {
  const sorted = [...view.rows].sort((a, b) => PRIORITY.indexOf(a.key) - PRIORITY.indexOf(b.key));
  const shown = sorted.slice(0, 3);
  const cut = sorted.slice(3);
  return (
    <Block id={NEEDS_YOU_ANCHOR} title="Needs you">
      {shown.length > 0 ? (
        // Each row is something a person approves, so its amounts never hide.
        <ul aria-label="Waiting on you" className="mt-1.5 pb-1" data-amounts="shown">
          {shown.map((r, i) => (
            <li key={r.key}>
              <RowLink
                href={r.href}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 transition-colors duration-150 hover:bg-accent sm:px-5"
              >
                <span className="min-w-0 flex-1 text-body font-medium text-foreground">{rowWords(r)}</span>
                {/* Every amount the row carries; with more than one (a chat's cards paying out and
                    coming in) each says which it is. */}
                {r.amounts.map((a) => (
                  <span key={a.label} className="text-body text-foreground-2">
                    {r.atLeast ? "At least " : null}
                    <Money cents={a.cents} tone="plain" />
                    {r.amounts.length > 1 ? ` ${a.label}` : null}
                  </span>
                ))}
                <span aria-hidden className={buttonVariants({ variant: i === 0 ? "primary" : "outline", size: "sm" })}>
                  Review
                </span>
              </RowLink>
            </li>
          ))}
        </ul>
      ) : null}
      {cut.length > 0 ? (
        <p className="px-4 pb-3 sm:px-5">
          <RowLink href={cut[0].href} className={LINK}>
            {moreLine(cut)}
          </RowLink>
        </p>
      ) : null}
      {view.unread ? (
        <p role="status" className="px-4 pt-2 pb-4 text-body text-foreground-2 sm:px-5">
          {NEEDS_YOU_UNREAD}
        </p>
      ) : view.rows.length === 0 ? (
        <p className="px-4 pt-1 pb-4 text-body text-foreground-2 sm:px-5">{NEEDS_YOU_NONE}</p>
      ) : null}
    </Block>
  );
}

const CHIP =
  "inline-flex min-h-8 cursor-pointer items-center rounded-full border border-border bg-card px-3 py-1 text-small text-foreground-2 transition-colors duration-150 hover:border-foreground-2 hover:text-foreground";

// Ask me anything: one wide box that opens the coworker's card (nothing is sent), and the first
// three of Home's questions, each put in the card's box with a tap. Without a card on the page a
// chip is a plain link to Home's ask.
export function AskAnything({ suggestions }: { suggestions: readonly Suggestion[] }) {
  const panel = useAgentPanel();
  return (
    <Block title="Ask me anything">
      <div className="grid gap-3 px-4 pt-3 pb-4 sm:px-5">
        <AskLink className="flex h-12 min-w-0 items-center gap-3 rounded-full border border-input bg-card pr-1.5 pl-4 text-body text-muted-foreground transition-colors duration-150 hover:border-foreground-2">
          <span className="min-w-0 flex-1 truncate">
            Ask about pay, invoices, drivers<span className="max-sm:hidden">, anything in LedgerLine</span>
          </span>
          <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
            <ArrowUp className="size-4" />
          </span>
        </AskLink>
        {suggestions.length > 0 ? (
          <ul aria-label="Questions to ask" className="flex flex-wrap gap-2">
            {suggestions.slice(0, 3).map((s) => (
              <li key={s.id}>
                {panel ? (
                  <button type="button" className={CHIP} onClick={() => panel.open({ draft: s.fill ?? s.label, help: s.help })}>
                    {s.label}
                  </button>
                ) : (
                  <AskLink className={CHIP}>{s.label}</AskLink>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-small text-muted-foreground">{TRUST_LINE}</p>
      </div>
    </Block>
  );
}
