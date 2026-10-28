"use client";

// The interactive pieces of /design. They live in a client module because their record links and
// button handlers are functions, which cannot cross from the server page.
import { CircleHelp, FileText, House, Truck, Users, Wallet } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChatThread, type ChatMessage } from "@/components/app/chat-thread";
import { DriverMoneyPanel } from "@/components/app/driver-money-panel";
import { MobileNav } from "@/components/app/mobile-nav";
import { NavList } from "@/components/app/nav-list";
import { ProposalCard, type ProposalStatus } from "@/components/app/proposal-card";
import { ToastView, useToast, type ToastTone } from "@/components/app/toast";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/format/money";
import {
  ADVANCE_PROPOSAL,
  DRIVER,
  LOADS,
  MONEY_IDENTITY,
  MONEY_IDENTITY_NOT_ARMED,
  MOVE_PROPOSAL,
  PAYMENT_PROPOSAL,
  RULE_CHANGE_PROPOSAL,
  SAMPLE_TENANT,
  SUGGESTIONS,
  type LoadRow,
} from "./sample-data";
import { anchorFor, loadColumns } from "./shared";

export function ProposalGallery({ prefix }: { prefix: string }) {
  const toast = useToast();
  const hrefFor = anchorFor(prefix);
  const [pending, setPending] = useState(false);
  // The sample approval settles after a short wait. Leaving the page first cancels it, so its toast
  // never shows up on another page.
  const approveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (approveTimer.current !== null) clearTimeout(approveTimer.current);
    },
    [],
  );
  const shown: { key: string; card: typeof ADVANCE_PROPOSAL; status: ProposalStatus; note: string }[] = [
    { key: "approved", card: PAYMENT_PROPOSAL, status: "approved", note: "Approved" },
    { key: "executing", card: PAYMENT_PROPOSAL, status: "executing", note: "Processing" },
    { key: "done", card: PAYMENT_PROPOSAL, status: "done", note: "Done" },
    { key: "rejected", card: MOVE_PROPOSAL, status: "rejected", note: "Rejected" },
    { key: "failed", card: ADVANCE_PROPOSAL, status: "failed", note: "Failed" },
    { key: "unknown", card: ADVANCE_PROPOSAL, status: "unknown", note: "Not confirmed yet" },
  ];
  return (
    <div className="grid gap-6">
      <Demo label="Waiting for approval. Approve asks once more; only Confirm acts.">
        <ProposalCard
          {...ADVANCE_PROPOSAL}
          id={`${prefix}advance`}
          status="proposed"
          hrefFor={hrefFor}
          pending={pending}
          onApprove={() => {
            setPending(true);
            approveTimer.current = setTimeout(() => {
              approveTimer.current = null;
              setPending(false);
              toast({ title: "Approved", body: `${formatCents(20_000)} advance to ${DRIVER.name} is queued.`, tone: "success" });
            }, 900);
          }}
          onReject={() => toast({ title: "Rejected", body: "Nothing was paid." })}
        />
      </Demo>
      <Demo label="The confirm step, open">
        <ProposalCard {...ADVANCE_PROPOSAL} id={`${prefix}advance-confirm`} status="proposed" hrefFor={hrefFor} initialConfirming />
      </Demo>
      <Demo label="A pay rule change: Save asks once more; nothing changes until it is saved.">
        <ProposalCard
          {...RULE_CHANGE_PROPOSAL}
          id={`${prefix}rule-change`}
          status="proposed"
          hrefFor={hrefFor}
          onApprove={() => toast({ title: "Saved", body: "Starts with the week of Nov 9. See it under Pay rules." })}
          onReject={() => toast({ title: "Not saved", body: "Nothing changed." })}
        />
      </Demo>
      {shown.map((s) => (
        <Demo key={s.key} label={s.note}>
          <ProposalCard {...s.card} id={`${prefix}${s.key}`} status={s.status} hrefFor={hrefFor} />
        </Demo>
      ))}
    </div>
  );
}

function Demo({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-2">
      <p className="text-caption text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

export function ChatDemo({ prefix }: { prefix: string }) {
  const toast = useToast();
  const hrefFor = anchorFor(prefix);
  const thread: ChatMessage[] = [
    { id: "q1", role: "user", at: "9:14 AM", parts: [{ kind: "text", text: `Can ${DRIVER.name} get a ${formatCents(20_000)} advance today?` }] },
    {
      id: "a1",
      role: "agent",
      parts: [
        {
          kind: "steps",
          steps: [
            { id: "s1", label: "Read 3 loads delivered this week", state: "done" },
            { id: "s2", label: "Checked open advances", state: "done" },
            { id: "s3", label: "Fuel card feed did not answer, so fuel is left out", state: "failed" },
            { id: "s4", label: "Writing up the proposal", state: "running" },
          ],
        },
        {
          kind: "text",
          text: `${DRIVER.name} earned ${formatCents(240_000)} this week and has no open advances. The limit is ${formatCents(50_000)}, so ${formatCents(20_000)} fits.`,
        },
        { kind: "proposal", proposal: { ...ADVANCE_PROPOSAL, id: `${prefix}chat-advance`, status: "proposed" } },
        {
          kind: "table",
          table: {
            caption: "Loads behind this week's pay",
            columns: loadColumns(hrefFor),
            rows: LOADS,
            rowKey: (r: LoadRow) => r.id,
            dense: true,
          },
        },
      ],
    },
  ];
  return (
    <div className="grid gap-10">
      <Demo label="Empty: the question, four suggestions, the box">
        <ChatThread
          messages={[]}
          suggestions={SUGGESTIONS}
          onPick={(id) => toast({ title: "Suggestion picked", body: SUGGESTIONS.find((s) => s.id === id)?.label })}
          intro="Ask about pay, advances, invoices or loads. Every answer links to the records behind it."
          composer={{ onSubmit: (text) => toast({ title: "Question sent", body: text }) }}
        />
      </Demo>
      <Demo label="A thread: a question, steps in all three states, a proposal and a table">
        <ChatThread
          messages={thread}
          hrefFor={hrefFor}
          composer={{ disabled: true, disabledReason: "Asking arrives with the next release" }}
        />
      </Demo>
    </div>
  );
}

const TOASTS: { tone: ToastTone; title: string; body: string; label: string }[] = [
  { tone: "success", title: "Approved", body: `${formatCents(20_000)} advance to ${DRIVER.name} is queued.`, label: "Success" },
  { tone: "neutral", title: "Pay run saved as a draft", body: "Nothing is paid until you approve it.", label: "Neutral" },
  { tone: "warning", title: "Waiting on the read-back", body: "The payment was sent. We will confirm it lands.", label: "Warning" },
  { tone: "destructive", title: "Payment failed", body: "Nothing was paid. Check the record before trying again.", label: "Error" },
];

export function ToastDemo() {
  const toast = useToast();
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        {TOASTS.map((t) => (
          <Button key={t.tone} variant="outline" onClick={() => toast({ tone: t.tone, title: t.title, body: t.body })}>
            {t.label} toast
          </Button>
        ))}
      </div>
      <p className="text-small text-muted-foreground">
        Success and neutral leave after 6 seconds, and wait while the pointer or focus is on them. A warning, an
        error or a toast with an action stays until dismissed. At most three show.
      </p>
    </div>
  );
}

export function ToastsAtRest() {
  return (
    <div className="grid max-w-[22rem] gap-2">
      {TOASTS.map((t) => (
        <ToastView key={t.tone} tone={t.tone} title={t.title} body={t.body} onDismiss={() => undefined} />
      ))}
    </div>
  );
}

const SAMPLE_NAV = [
  { href: "#identity", label: "Home", icon: <House aria-hidden />, current: true },
  { href: "#stat-cards", label: "Drivers", icon: <Users aria-hidden /> },
  { href: "#data-table", label: "Loads", icon: <Truck aria-hidden /> },
  { href: "#paystub", label: "Pay runs", icon: <Wallet aria-hidden /> },
  { href: "#proposal-card", label: "Invoices", icon: <FileText aria-hidden /> },
];

export function SheetDemo() {
  return (
    <MobileNav
      homeHref="#identity"
      alwaysShow
      buttonLabel="Open the phone menu"
      help={
        <Link href="#identity" className="flex items-center gap-2 text-body text-foreground-2 hover:text-foreground">
          <CircleHelp aria-hidden className="size-4" />
          How trucking pay works
        </Link>
      }
    >
      <NavList items={SAMPLE_NAV} />
    </MobileNav>
  );
}

// The driver's money panel as an admin and as staff. Presses here go nowhere: the sample answers
// that it saved, and nothing is read again.
const demoSend = async () => ({ ok: true, error: null });

export function MoneyPanelDemo() {
  return (
    <div className="grid gap-4">
      <DriverMoneyPanel identity={MONEY_IDENTITY} canAdmin timezone={SAMPLE_TENANT.timezone} send={demoSend} />
      <DriverMoneyPanel identity={MONEY_IDENTITY_NOT_ARMED} canAdmin={false} timezone={SAMPLE_TENANT.timezone} send={demoSend} />
    </div>
  );
}
