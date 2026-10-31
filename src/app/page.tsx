import { flags } from "@/config/flags";
import type { AgentOpening } from "@/components/agent/panel-context";
import {
  defaultSuggestions,
  ruleChangeSuggestion,
  startingSuggestions,
  withPaystubSuggestion,
} from "@/components/agent/suggestions";
import { appNav } from "@/components/app/app-nav";
import { AppShell } from "@/components/app/app-shell";
import { HOW_PAY_WORKS } from "@/components/app/signed-in-page";
import { DataTable } from "@/components/app/data-table";
import { NeedsYou } from "@/components/app/needs-you";
import { StatCard } from "@/components/app/stat-card";
import { ErrorState } from "@/components/app/states";
import { StatusBadge } from "@/components/app/status-badge";
import { Wordmark } from "@/components/brand/wordmark";
import { FridayPay } from "@/components/cash/friday-pay";
import { Greeting, type Shortcut } from "@/components/home/greeting";
import { HomeCard, Unavailable } from "@/components/home/home-card";
import { CashFlowCard, OwedCard } from "@/components/home/money-cards";
import { PaydayCard } from "@/components/home/payday-card";
import { TodayCard } from "@/components/home/today-card";
import { NewHereLine } from "@/components/help/how-pay-works";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  capNanocents,
  centsToDisplay,
  dollarsToDisplay,
  wonderCapNanocents,
} from "@/lib/ai/prices";
import { readRecentCalls, readSpend, type CallRow, type Spend } from "@/lib/ai/spend";
import { dismissKey } from "@/lib/asks/dismiss-key";
import { readCashHome } from "@/lib/cash/view";
import { DbError } from "@/lib/db";
import { readRecentAgentTurns } from "@/lib/agent/gateway/store";
import type { TurnView } from "@/lib/agent/view";
import type { Session } from "@/lib/auth/claims";
import { isRole, type Role } from "@/lib/auth/role";
import { formatInstant } from "@/lib/format/dates";
import { owedOf, paydayOf, type Owed, type Payday } from "@/lib/home/cards";
import { loaded, type Loaded } from "@/lib/home/loaded";
import { readMoneyFlow, type FlowWeek } from "@/lib/home/money-flow";
import { cardsRow, readNeedsYou, type NeedsYouRow, type NeedsYouView } from "@/lib/home/needs-you";
import { readTodayIntake, type TodayIntake } from "@/lib/home/today";
import { readInvoiceList } from "@/lib/invoices/views";
import { readNextWeekStart } from "@/lib/pay-rules/read";
import { codeToWords, modelCallStatusLabel } from "@/lib/format/labels";
import { readPaystubAsk } from "@/lib/settlements/list";
import { readSettlementsView } from "@/lib/settlements/views";
import { readSweepHome } from "@/lib/sweep/view";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { carrierToday } from "@/lib/tenant/shell";
import { localTimeOf, type LocalDate } from "@/lib/time/local-date";
import { isUuid } from "@/lib/uuid";
import { AiProofForm } from "./ai-proof-form";

type ModelLedger = { calls: CallRow[]; spend: Spend };
type Carrier = {
  name: string;
  timezone: string;
  email: string;
  role: Role;
  counts: { drivers: number; loads: number; periods: number };
  ledger: ModelLedger | null;
  paystub: { driverName: string; periodEnd: string } | null;
  session: Session;
  admin: boolean;
  // The first date a pay rule change may start, while pay rule changes are switched on.
  nextStart: LocalDate | null;
};

// The signed-in carrier's shell. Every read runs inside withRequestTenant, so this page can only
// ever see the carrier on the verified token. Signed out: withRequestTenant redirects to /sign-in.
// Each of these opens the agent card as the page loads, its question box already filled:
// ?document=<input id>, from a document's page: a request to check that document. Only an id is
// taken from the address; the text around it is fixed.
// ?rule=1, from the Pay rules page: with pay rule changes switched on, the example sentence and the
// help under it.
// ?paystub=<settlement id>: "Ask about this paystub" links here with the paystub's id; its question
// goes first among the suggestions and fills the box. Anything else is ignored.
// ?ask=<card>, from a Home card's "Ask about this": that card's question, one of the suggested
// questions; only the card's name is taken from the address.
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // One clock for the whole page, so the greeting, the Today card and the cards all read the
  // same carrier date, even across midnight.
  const now = new Date();
  const params = await searchParams;
  const asked = params.document;
  const documentInput = typeof asked === "string" && isUuid(asked) ? asked : null;
  const ruleAsked = params.rule === "1";
  // The demo banner's "Start over": the card opens on a new conversation, and a demo visitor's
  // Needs you reads no turns.
  const startOver = params.new === "1";
  const askedPaystub = params.paystub;
  const askedCard = isCardAsk(params.ask) ? params.ask : null;
  const paystubId =
    typeof askedPaystub === "string" && isUuid(askedPaystub) ? askedPaystub.toLowerCase() : null;
  let carrier: Carrier | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    carrier = await withRequestTenant(async (q, session) => {
      const tenants = await q.query<{ name: string; timezone: string }>(
        "SELECT name, timezone FROM tenants WHERE id = current_tenant_id()",
      );
      const members = await q.query<{ email: string; role: unknown }>(
        "SELECT email, role FROM memberships WHERE cognito_sub = $1",
        [session.sub],
      );
      if (tenants.length !== 1 || members.length !== 1) throw new ForbiddenError();
      const role = members[0].role;
      if (!isRole(role)) throw new ForbiddenError();
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
        role,
        counts,
        ledger,
        paystub,
        session,
        admin: role === "admin",
        nextStart: flags.rulesByTalkingEnabled ? await readNextWeekStart(q, now) : null,
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

  // Home's reads after the carrier's. Each runs in its own carrier transaction and none needs
  // another, so they all start at once: the page waits for the slowest read, not for each in turn.
  const reads = carrier
    ? await Promise.all([
        readTurns(carrier, startOver),
        readNeedsRows(carrier, now),
        // The last sweep, for the Today card while the sweep is on. A failed database or membership
        // read says so on the card; any other error goes on to Next.
        flags.sweepEnabled
          ? loaded("sweep home", async () => (await readSweepHome(carrier.session)).runs[0] ?? null)
          : null,
        // Friday's pay run, when Cash Friday is on: the latest check's verdict, that it is out of
        // date (its pay day has passed), or that there is none.
        // A failed database or membership read says so on the card, never "not checked"; any other
        // error goes on to Next.
        flags.cashFridayEnabled ? loaded("cash home", () => readCashHome(carrier.session)) : null,
        // Home's cards, each in its own carrier transaction and only while its page is on, so one
        // failed read shows that card as unavailable and leaves the rest of the page alone.
        readCards(carrierToday(carrier.timezone, now)),
      ])
    : null;

  if (!carrier || !reads) {
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

  const [turns, needsRows, lastSweep, cashHome, cards] = reads;
  const agentTurns = turns.turns;
  // "Needs you" never reads as "nothing is waiting" when its rows or the agent's turns were not read.
  const rows = needsRows ?? [];
  const cardsAsk = flags.agentEnabled ? cardsRow(agentTurns) : null;
  const needsYou: NeedsYouView = {
    rows: cardsAsk ? [cardsAsk, ...rows] : rows,
    unread: turns.unread || needsRows === null,
  };

  // The card's questions on Home: every page's, plus the pay rule change dated the first week a
  // change can start, with the paystub's question first when one was asked about.
  const base = [...defaultSuggestions(), ...(carrier.nextStart ? [ruleChangeSuggestion(carrier.nextStart)] : [])];
  const suggestions = withPaystubSuggestion(base, carrier.paystub);
  // ?rule=1 fills the box with the chip's own sentence and help.
  const ruleAsk = !documentInput && ruleAsked && carrier.nextStart ? ruleChangeSuggestion(carrier.nextStart) : null;
  const cardAsk = askedCard
    ? startingSuggestions().find((s) => CARD_ASKS[askedCard].includes(s.id))?.label
    : undefined;
  const opening = agentOpening({
    draft: documentInput
      ? `Check document ${documentInput}`
      : (ruleAsk?.fill ?? cardAsk ?? (carrier.paystub ? suggestions[0]?.label : undefined)),
    help: ruleAsk?.help,
    fresh: startOver,
  });
  // A card's "Ask about this", while the agent can answer: Home again, with the card open on its
  // question.
  const askHref = (card: CardAsk) => (flags.agentEnabled ? `/?ask=${card}` : undefined);
  const today = carrierToday(carrier.timezone, now);

  return (
    <AppShell
      tenant={{
        name: carrier.name,
        email: carrier.email,
        timezone: carrier.timezone,
        role: carrier.role,
        asksKey: dismissKey(carrier.session.tenantId, carrier.session.sub),
      }}
      nav={appNav("/")}
      help={HOW_PAY_WORKS}
      title="Home"
      signOut={signOut}
      suggestions={suggestions}
      agentOpening={opening}
      // The bell's dot counts only a read that came back; an unread list never reads as zero.
      needsYouCount={needsYou.unread ? undefined : needsYou.rows.length}
      // The sidebar's pinned amounts, from the cards' own reads; a card not read leaves its out.
      pinned={{
        payWeekCents: cards.payday?.ok ? cards.payday.value.netCents : undefined,
        dueCents: cards.owed?.ok ? cards.owed.value.owedCents : undefined,
      }}
    >
      <h1 className="sr-only">Home</h1>
      <div className="grid gap-8">
        <Greeting
          name={carrier.name}
          today={today}
          hour={localTimeOf(now.toISOString(), carrier.timezone).hour}
          shortcuts={shortcuts()}
        />
        {/* What the agent did today and what needs your OK come first. */}
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <TodayCard
            intake={cards.intake}
            shown={{ documents: flags.documentsEnabled, voiceNotes: flags.voiceIntakeEnabled, messages: flags.inboxEnabled }}
            sweep={lastSweep}
            needs={needsYou}
            today={today}
            timezone={carrier.timezone}
          />
          <NeedsYou view={needsYou} />
        </div>
        <NewHereLine />
        {/* Then payday: this pay week's paystubs, Friday's pay run and the drivers on file. */}
        <section aria-labelledby="pay-week-title" className="grid gap-3">
          <h2 id="pay-week-title" className="text-h2 text-foreground">
            This pay week
          </h2>
          <div className="grid items-stretch gap-4 lg:grid-cols-2">
            {cards.payday ? <PaydayCard payday={cards.payday} askHref={askHref("payday")} /> : null}
            <div className="grid content-start gap-4">
              {cashHome ? (
                cashHome.ok ? (
                  <FridayPay home={cashHome.value} today={today} className="mt-0 max-w-none" />
                ) : (
                  <HomeCard title="Friday's pay run" link={{ href: "/cash", label: "Open the Cash page" }}>
                    <Unavailable>Could not read the last check of Friday&apos;s pay run.</Unavailable>
                  </HomeCard>
                )
              ) : null}
              <StatCard
                label="Drivers"
                value={carrier.counts.drivers.toLocaleString("en-US")}
                hint={flags.driverNotesEnabled ? "Open driver notes" : undefined}
                href={flags.driverNotesEnabled ? "/driver-notes" : undefined}
              />
            </div>
          </div>
        </section>
        {/* Then money: what came in and went out, and what customers owe. */}
        {cards.flow || cards.owed ? (
          <section aria-labelledby="money-title" className="grid gap-3">
            <h2 id="money-title" className="text-h2 text-foreground">
              Money
            </h2>
            <div className="grid items-stretch gap-4 lg:grid-cols-2">
              {cards.flow ? <CashFlowCard flow={cards.flow} askHref={askHref("cash")} /> : null}
              {cards.owed ? <OwedCard owed={cards.owed} askHref={askHref("owed")} /> : null}
            </div>
          </section>
        ) : null}
        {carrier.ledger ? <ModelCheck ledger={carrier.ledger} timezone={carrier.timezone} /> : null}
      </div>
    </AppShell>
  );
}

// Each card's "Ask about this" question: the first of these suggested questions on offer.
type CardAsk = "payday" | "cash" | "owed";
const CARD_ASKS: Record<CardAsk, readonly string[]> = {
  payday: ["paystub-problems"],
  cash: ["make-pay-run", "pay-run-cost"],
  owed: ["past-60"],
};
const isCardAsk = (v: unknown): v is CardAsk => typeof v === "string" && Object.hasOwn(CARD_ASKS, v);

type Cards = {
  intake: Loaded<TodayIntake> | null;
  payday: Loaded<Payday> | null;
  flow: Loaded<FlowWeek[]> | null;
  owed: Loaded<Owed> | null;
};

// null is a card whose page is switched off, so it is not shown at all.
async function readCards(today: LocalDate): Promise<Cards> {
  const intakeOn = flags.documentsEnabled || flags.voiceIntakeEnabled || flags.inboxEnabled;
  const [intake, payday, flow, owed] = await Promise.all([
    intakeOn ? loaded("intake", () => withRequestTenant((q) => readTodayIntake(q, today))) : null,
    flags.settlementsEnabled
      ? loaded("payday", () => withRequestTenant(async (q) => paydayOf(await readSettlementsView(q, null))))
      : null,
    flags.settlementsEnabled && flags.invoicesEnabled
      ? loaded("money flow", () => withRequestTenant((q) => readMoneyFlow(q, today)))
      : null,
    flags.invoicesEnabled
      ? loaded("owed", () => withRequestTenant(async (q) => owedOf(await readInvoiceList(q, today))))
      : null,
  ]);
  return { intake, payday, flow, owed };
}

// The agent's recent turns, for a reload to show the same thread. A failed read shows an empty
// thread with the box still working; the turns are read back again on the next question.
async function readTurns(carrier: Carrier, startOver: boolean): Promise<{ turns: TurnView[]; unread: boolean }> {
  if (!flags.agentEnabled || (startOver && carrier.role === "judge")) return { turns: [], unread: false };
  try {
    return { turns: await readRecentAgentTurns(carrier.session), unread: false };
  } catch (err) {
    console.error("agent turns read failed:", err instanceof Error ? err.name : "unknown");
    return { turns: [], unread: true };
  }
}

// "Needs you": its own carrier transaction, so a failed read here never takes the page down.
// null is a failed database or membership read; any other error goes on to Next.
async function readNeedsRows(carrier: Carrier, now: Date): Promise<NeedsYouRow[] | null> {
  try {
    return await withRequestTenant((q) =>
      readNeedsYou(q, {
        today: carrierToday(carrier.timezone, now),
        settlements: flags.settlementsEnabled,
        advances: flags.advancesEnabled,
        invoices: flags.invoicesEnabled,
        ...(flags.verification.enabled && flags.agentEnabled
          ? {
              escalations: {
                now,
                sub: carrier.session.sub,
                visitId: carrier.session.demoSessionId ?? null,
              },
            }
          : {}),
      }),
    );
  } catch (err) {
    if (!(err instanceof ForbiddenError || err instanceof DbError)) throw err;
    console.error("needs you read failed:", err.name);
    return null;
  }
}

// The greeting's shortcuts, each only while its page is on. Running payday opens the sweep when it
// is on, else the pay run.
function shortcuts(): Shortcut[] {
  const payday = flags.sweepEnabled ? "/sweep" : flags.settlementsEnabled ? "/settlements" : null;
  return [
    payday ? { label: "Run payday", href: payday } : null,
    flags.advancesEnabled ? { label: "Advance", href: "/advances/new" } : null,
    flags.documentsEnabled ? { label: "Upload document", href: "/documents" } : null,
    flags.customerPaymentsEnabled ? { label: "Record payment", href: "/customer-payments/new" } : null,
  ].filter((s) => s !== null);
}

// What Home asks the card to open with, or undefined when nothing was asked (the card stays
// closed). A visit that only starts over opens the card empty on a new conversation.
function agentOpening(o: { draft?: string; help?: string; fresh: boolean }): AgentOpening | undefined {
  if (o.draft === undefined && !o.fresh) return undefined;
  return {
    ...(o.draft !== undefined ? { draft: o.draft, ...(o.help !== undefined ? { help: o.help } : {}) } : {}),
    ...(o.fresh ? { fresh: true } : {}),
  };
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
