import Link from "next/link";
import { flags } from "@/config/flags";
import { DETENTION_SUGGESTION, homeSuggestions, withPaystubSuggestion } from "@/components/agent/suggestions";
import { AgentChat } from "@/components/agent/turn-view";
import { appNav } from "@/components/app/app-nav";
import { AppShell } from "@/components/app/app-shell";
import { ChatThread } from "@/components/app/chat-thread";
import { DataTable } from "@/components/app/data-table";
import { NeedsYou } from "@/components/app/needs-you";
import { StatCard } from "@/components/app/stat-card";
import { ErrorState } from "@/components/app/states";
import { StatusBadge } from "@/components/app/status-badge";
import { Wordmark } from "@/components/brand/wordmark";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  capNanocents,
  centsToDisplay,
  dollarsToDisplay,
  wonderCapNanocents,
} from "@/lib/ai/prices";
import { readRecentCalls, readSpend, type CallRow, type Spend } from "@/lib/ai/spend";
import { DbError } from "@/lib/db";
import { readRecentAgentTurns } from "@/lib/agent/gateway/store";
import type { TurnView } from "@/lib/agent/view";
import type { Session } from "@/lib/auth/claims";
import { formatInstant } from "@/lib/format/dates";
import { cardsRow, readNeedsYou, type NeedsYouRow, type NeedsYouView } from "@/lib/home/needs-you";
import { codeToWords, modelCallStatusLabel } from "@/lib/format/labels";
import { readPaystubAsk } from "@/lib/settlements/list";
import { readSweepHome, type SweepRunView } from "@/lib/sweep/view";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { carrierToday } from "@/lib/tenant/shell";
import { isUuid } from "@/lib/uuid";
import { AiProofForm } from "./ai-proof-form";

type ModelLedger = { calls: CallRow[]; spend: Spend };
type Carrier = {
  name: string;
  timezone: string;
  email: string;
  counts: { drivers: number; loads: number; periods: number };
  ledger: ModelLedger | null;
  paystub: { driverName: string; periodEnd: string } | null;
  session: Session;
};

// The signed-in carrier's shell. Every read runs inside withRequestTenant, so this page can only
// ever see the carrier on the verified token. Signed out: withRequestTenant redirects to /sign-in.
// ?document=<input id>, from a document's page: the question box starts with a request to check
// that document. Only an id is taken from the address; the text around it is fixed.
// ?paystub=<settlement id>: "Ask about this paystub" links here with the paystub's id; anything
// else is ignored.
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const asked = params.document;
  const documentInput = typeof asked === "string" && isUuid(asked) ? asked : null;
  const askedPaystub = params.paystub;
  const paystubId =
    typeof askedPaystub === "string" && isUuid(askedPaystub) ? askedPaystub.toLowerCase() : null;
  let carrier: Carrier | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    carrier = await withRequestTenant(async (q, session) => {
      const tenants = await q.query<{ name: string; timezone: string }>(
        "SELECT name, timezone FROM tenants WHERE id = current_tenant_id()",
      );
      const members = await q.query<{ email: string }>(
        "SELECT email FROM memberships WHERE cognito_sub = $1",
        [session.sub],
      );
      if (tenants.length !== 1 || members.length !== 1) throw new ForbiddenError();
      // Each count names its tenant, as every read does.
      const [counts] = await q.query<{ drivers: number; loads: number; periods: number }>(
        `SELECT (SELECT count(*) FROM drivers WHERE tenant_id = current_tenant_id()) AS drivers,
                (SELECT count(*) FROM loads WHERE tenant_id = current_tenant_id()) AS loads,
                (SELECT count(*) FROM settlement_periods WHERE tenant_id = current_tenant_id())
                  AS periods`,
      );
      if (!counts) throw new DbError("unknown");
      // The model check's read-back, from the database on every render: this carrier's newest
      // calls (row-level security applies) and the global spend counter.
      const ledger = flags.aiProofRoute
        ? { calls: await readRecentCalls(q, 5), spend: await readSpend(q) }
        : null;
      const paystub = paystubId ? await readPaystubAsk(q, paystubId) : null;
      return {
        name: tenants[0].name,
        timezone: tenants[0].timezone,
        email: members[0].email,
        counts,
        ledger,
        paystub,
        session,
      };
    });
  } catch (err) {
    // Anything else (the redirect to /sign-in among them) goes on to Next.
    if (err instanceof ForbiddenError) problem = "forbidden";
    else if (err instanceof DbError) problem = "unreadable";
    else throw err;
  }

  const signOut = (
    <form action="/api/auth/sign-out" method="post">
      <Button type="submit" variant="ghost" className="w-full justify-start">
        Sign out
      </Button>
    </form>
  );

  // The agent's recent turns, for a reload to show the same thread. A failed read shows an empty
  // thread with the box still working; the turns are read back again on the next question.
  let agentTurns: TurnView[] = [];
  let turnsUnread = false;
  if (carrier && flags.agentEnabled) {
    try {
      agentTurns = await readRecentAgentTurns(carrier.session);
    } catch (err) {
      turnsUnread = true;
      console.error("agent turns read failed:", err instanceof Error ? err.name : "unknown");
    }
  }

  // "Needs you": its own carrier transaction, so a failed read here never takes the page down and
  // never reads as "nothing is waiting".
  let needsYou: NeedsYouView | null = null;
  if (carrier) {
    let rows: NeedsYouRow[] = [];
    let unread = turnsUnread;
    try {
      const today = carrierToday(carrier.timezone, new Date());
      rows = await withRequestTenant((q) =>
        readNeedsYou(q, {
          today,
          settlements: flags.settlementsEnabled,
          advances: flags.advancesEnabled,
          invoices: flags.invoicesEnabled,
        }),
      );
    } catch (err) {
      if (!(err instanceof ForbiddenError || err instanceof DbError)) throw err;
      unread = true;
      console.error("needs you read failed:", err.name);
    }
    const cards = flags.agentEnabled ? cardsRow(agentTurns) : null;
    needsYou = { rows: cards ? [cards, ...rows] : rows, unread };
  }

  // The last sweep's line, when the sweep is on. A failed read leaves the card out.
  let lastSweep: SweepRunView | null = null;
  if (carrier && flags.sweepEnabled) {
    try {
      lastSweep = (await readSweepHome(carrier.session)).runs[0] ?? null;
    } catch (err) {
      console.error("sweep home read failed:", err instanceof Error ? err.name : "unknown");
    }
  }

  if (!carrier) {
    return (
      <main className="flex min-h-dvh flex-col items-center bg-background px-4 pt-16 pb-10 sm:pt-24">
        <div className="grid w-full max-w-[440px] gap-6">
          <h1 className="sr-only">LedgerLine</h1>
          <Wordmark size="lg" className="justify-self-center" />
          <Card>
            {/* Unknown is not empty: a failed or timed-out read never shows as "no data". */}
            <ErrorState category={problem === "forbidden" ? "forbidden" : "unreadable"} />
            <div className="border-t border-border p-3">{signOut}</div>
          </Card>
        </div>
      </main>
    );
  }

  const base = flags.detentionEnabled ? [...SUGGESTIONS, DETENTION_SUGGESTION] : SUGGESTIONS;
  const suggestions = withPaystubSuggestion(base, carrier.paystub);

  return (
    <AppShell
      tenant={{ name: carrier.name, email: carrier.email, timezone: carrier.timezone }}
      nav={appNav("/")}
      title="Home"
      signOut={signOut}
    >
      <h1 className="sr-only">Home</h1>
      {needsYou ? <NeedsYou view={needsYou} /> : null}
      <RecordCounts counts={carrier.counts} />
      {flags.agentEnabled ? (
        <AgentChat
          initialTurns={agentTurns}
          streamMode={flags.agentStreamMode}
          auditorOn={flags.auditorEnabled}
          timezone={carrier.timezone}
          suggestions={suggestions}
          initialDraft={documentInput ? `Check document ${documentInput}` : undefined}
          intro="Ask in plain words. Every number comes from your records, and nothing is paid or sent until you approve it."
          disabledReason={
            flags.aiEnabled ? undefined : "The models are switched off, so the agent cannot answer right now."
          }
        />
      ) : (
        <ChatThread
          messages={[]}
          suggestions={SUGGESTIONS}
          intro="Drivers, loads and this week's pay run arrive with the next items."
          composer={{ disabled: true, disabledReason: "Asking arrives with the next release" }}
        />
      )}
      {lastSweep ? <LastSweep run={lastSweep} /> : null}
      {carrier.ledger ? <ModelCheck ledger={carrier.ledger} timezone={carrier.timezone} /> : null}
    </AppShell>
  );
}

// Shown before the agent can answer; they light up when it can.
const SUGGESTIONS = homeSuggestions(flags.reportsEnabled);

// "Last sweep: 7 problems, 5 fixes drafted, 2 approved", one click from the run.
function LastSweep({ run }: { run: SweepRunView }) {
  const found = run.counts.found ?? 0;
  const drafted = run.counts.fixes_drafted ?? 0;
  const line =
    run.status === "running"
      ? "A sweep is running now."
      : run.status === "failed"
        ? "The last sweep stopped before it finished."
        : `Last sweep: ${found} ${found === 1 ? "problem" : "problems"}, ${drafted} ${drafted === 1 ? "fix" : "fixes"} drafted, ${run.approved} approved.`;
  return (
    <section aria-label="Last sweep" className="mx-auto mt-12 w-full max-w-[720px]">
      <Card className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-4 sm:px-5">
        <p className="text-body text-foreground">{line}</p>
        <Link href={`/sweep/${run.id}`} className="text-small text-link underline-offset-4 hover:underline">
          Open the sweep
        </Link>
      </Card>
    </section>
  );
}

// What this carrier has on file, from the counts read above, under "Needs you" so it never
// scrolls away under the thread. Pay periods opens Driver notes, where each week is listed.
function RecordCounts({ counts }: { counts: Carrier["counts"] }) {
  return (
    <section aria-label="Records on file" className="mx-auto mt-3 mb-6 grid w-full max-w-[720px] grid-cols-2 gap-3">
      <StatCard label="Drivers" value={counts.drivers.toLocaleString("en-US")} />
      <StatCard
        label="Pay periods"
        value={counts.periods.toLocaleString("en-US")}
        hint={flags.driverNotesEnabled ? "Open driver notes" : undefined}
        href={flags.driverNotesEnabled ? "/driver-notes" : undefined}
      />
    </section>
  );
}

const PURPOSE_WORDS: Record<string, string> = { proof: "Connection test" };

// created_utc is "YYYY-MM-DD HH24:MI:SS" in UTC. Shown in the carrier's zone; if it ever arrives
// in another shape, it reads "Time not known" rather than a guess or a raw stamp.
function callTime(createdUtc: string, timezone: string): string {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(createdUtc)) {
    try {
      return formatInstant(`${createdUtc.replace(" ", "T")}Z`, timezone);
    } catch {
      // Falls through to the stored text.
    }
  }
  return "Time not known";
}

function ModelCheck({ ledger, timezone }: { ledger: ModelLedger; timezone: string }) {
  const cap = capNanocents(process.env.AI_SPEND_CAP_CENTS);
  const wonderCap = wonderCapNanocents(process.env.AI_WONDER_CAP_CENTS, cap);
  const { spend } = ledger;
  const wonderHint = [
    wonderCap === null
      ? "No Wonder cap, so every Wonder call is refused"
      : `Of its ${dollarsToDisplay(wonderCap)} cap`,
    spend.wonderReservedNanocents > 0
      ? `plus ${dollarsToDisplay(spend.wonderReservedNanocents)} held`
      : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <Card className="mx-auto mt-12 w-full max-w-[720px]">
      <CardHeader>
        <div className="grid gap-0.5">
          <CardTitle>Model connection</CardTitle>
          <CardDescription>A test call to the model, counted against the spend cap.</CardDescription>
        </div>
      </CardHeader>
      <CardBody className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <StatCard
            label="Spent"
            value={dollarsToDisplay(spend.spentNanocents)}
            hint={
              spend.reservedNanocents > 0
                ? `Plus ${dollarsToDisplay(spend.reservedNanocents)} held for calls in flight or with no answer`
                : undefined
            }
          />
          <StatCard
            label="Cap"
            value={cap === null ? "None" : dollarsToDisplay(cap)}
            hint={cap === null ? "No cap, so every call is refused" : undefined}
            tone={cap === null ? "warning" : "neutral"}
          />
          <StatCard label="Calls" value={spend.calls.toLocaleString("en-US")} />
          <StatCard
            label="Wonder spent"
            value={dollarsToDisplay(spend.wonderSpentNanocents)}
            hint={wonderHint}
            tone={wonderCap === null ? "warning" : "neutral"}
          />
        </div>
        <AiProofForm />
        <DataTable<CallRow>
          caption="Newest model calls"
          rows={ledger.calls}
          rowKey={(c) => c.id}
          dense
          pinFirstColumn
          empty={{ title: "No model calls yet", body: "The test above makes the first one." }}
          columns={[
            {
              key: "time",
              header: "Time",
              cell: (c) => <span className="whitespace-nowrap">{callTime(c.created_utc, timezone)}</span>,
            },
            {
              key: "model",
              header: "Model",
              cell: (c) => (
                <span className="whitespace-nowrap">
                  {codeToWords(c.target)}
                  <span className="block text-small text-muted-foreground">
                    {codeToWords(c.kind)}
                    {c.reasoning_effort ? `, ${c.reasoning_effort} effort` : ""}
                  </span>
                </span>
              ),
            },
            {
              key: "purpose",
              header: "Purpose",
              cell: (c) => PURPOSE_WORDS[c.purpose] ?? codeToWords(c.purpose),
            },
            {
              key: "status",
              header: "Status",
              cell: (c) => (
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <StatusBadge status={c.status} label={modelCallStatusLabel(c.status)} />
                  {c.failure ? <span className="text-small text-muted-foreground">{codeToWords(c.failure)}</span> : null}
                </span>
              ),
            },
            {
              key: "usage",
              header: "Usage",
              align: "right",
              cell: (c) =>
                c.input_tokens !== null || c.units !== null ? (
                  <span className="whitespace-nowrap">
                    {c.input_tokens !== null ? (
                      <>
                        {c.input_tokens.toLocaleString("en-US")} in, {(c.output_tokens ?? 0).toLocaleString("en-US")} out
                        <span className="block text-small text-muted-foreground">
                          {(c.reasoning_tokens ?? 0).toLocaleString("en-US")} reasoning
                        </span>
                      </>
                    ) : null}
                    {c.units !== null ? (
                      <span className="block">
                        {c.units.toLocaleString("en-US")} {c.kind === "transcribe" ? "audio seconds" : "images"}
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span className="text-muted-foreground">Not recorded</span>
                ),
            },
            {
              key: "duration",
              header: "Duration",
              align: "right",
              cell: (c) =>
                c.duration_ms !== null ? (
                  <span className="whitespace-nowrap">{c.duration_ms.toLocaleString("en-US")} ms</span>
                ) : (
                  <span className="text-muted-foreground">Not recorded</span>
                ),
            },
            {
              key: "cost",
              header: "Cost",
              align: "right",
              cell: (c) =>
                c.cost_nanocents !== null ? (
                  <span className="whitespace-nowrap">{centsToDisplay(c.cost_nanocents)} cents</span>
                ) : (
                  <span className="text-muted-foreground">Not settled</span>
                ),
            },
            {
              key: "upstream",
              header: "Reference",
              cell: (c) =>
                c.upstream_id ? (
                  <details className="text-small">
                    <summary className="cursor-pointer text-link">Details</summary>
                    <span className="whitespace-nowrap text-muted-foreground">Reference {c.upstream_id.slice(-6)}</span>
                  </details>
                ) : (
                  <span className="text-muted-foreground">None</span>
                ),
            },
          ]}
        />
      </CardBody>
    </Card>
  );
}
