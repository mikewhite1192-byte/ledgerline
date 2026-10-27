import { Cpu } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/app/states";
import { StatCard } from "@/components/app/stat-card";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { countWords, formatCachedShare, formatLatency, formatSaved, formatSpend } from "@/lib/trace/format";
import type { ModelTotals, ModelWeek } from "@/lib/trace/week";
import { formatPeriod } from "@/lib/format/dates";

// The Meta models page's body: one card per model with what it does here, its calls, spend,
// prompt cache share and typical time this week, then the gateway's and the screener's totals.
// Plain data in, no reads.

export type DemoBudget = { spentNanocents: number; capNanocents: number | null };

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-small text-foreground-2">{label}</dt>
      <dd className="text-small font-medium text-foreground tabular-nums">{value}</dd>
    </div>
  );
}

const count = (n: number) => n.toLocaleString("en-US");

// "71% of input tokens, saved 84.3 cents at list price", or null for a model with no token counts this week.
function cacheRow(m: { cachedShare: number | null; cachedTokens: number; savedNanocents: number | null }): string | null {
  const share = formatCachedShare(m.cachedShare, m.cachedTokens);
  if (share === null) return null;
  return m.cachedTokens === 0 ? "none" : `${share} of input tokens, saved ${formatSaved(m.savedNanocents)} at list price`;
}

// The page's prompt cache sentence, or null when no call this week was metered in tokens.
export function weekCacheLine(week: ModelWeek): string | null {
  const share = formatCachedShare(week.cachedShare, week.cachedTokens);
  if (share === null) return null;
  if (week.cachedTokens === 0) return "Prompt cache: no input tokens were read from the cache this week.";
  const saving =
    week.savedNanocents === null ? "; the saving is not known" : `, saving ${formatSaved(week.savedNanocents)} at list price`;
  return `Prompt cache: ${share} of input tokens were cached this week${saving}.`;
}

function ModelCard({ m }: { m: ModelTotals }) {
  const p50 = formatLatency(m.p50Ms);
  const cache = cacheRow(m);
  return (
    <Card className="min-w-0">
      <CardHeader>
        <div className="grid gap-0.5">
          <CardTitle>{m.name}</CardTitle>
          <CardDescription>{m.job}</CardDescription>
        </div>
      </CardHeader>
      <CardBody>
        {m.calls === 0 ? (
          <p className="text-small text-muted-foreground">No calls this week.</p>
        ) : (
          <dl className="grid divide-y divide-border">
            <Row label="Calls" value={count(m.calls)} />
            <Row label="Finished" value={count(m.ok)} />
            {m.incomplete > 0 ? <Row label="Cut short" value={count(m.incomplete)} /> : null}
            {m.failed > 0 ? <Row label="Failed" value={count(m.failed)} /> : null}
            {m.pending > 0 ? <Row label="Running or outcome not known" value={count(m.pending)} /> : null}
            <Row label="Spent" value={formatSpend(m.costNanocents)} />
            {m.unsettled > 0 ? (
              <Row
                label={`Held for ${countWords(m.unsettled, "call", "calls")} not settled`}
                value={formatSpend(m.heldNanocents)}
              />
            ) : null}
            {cache ? <Row label="From the prompt cache" value={cache} /> : null}
            <Row label="Typical time (half finish within)" value={p50 ?? "not measured"} />
            {m.versions.length > 0 ? <Row label="Ran as" value={m.versions.join(", ")} /> : null}
          </dl>
        )}
      </CardBody>
    </Card>
  );
}

export function ModelWeekView({ week, budget }: { week: ModelWeek; budget?: DemoBudget | null }) {
  const period = formatPeriod(week.week.start, week.week.end);
  const cacheLine = weekCacheLine(week);
  const quiet = week.calls === 0 && week.decisions.total === 0 && week.screenings.total === 0;
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h2 className="text-h2 text-foreground">This pay week</h2>
        <p className="text-body text-foreground-2">
          {period}, in {week.week.zone} time. Every model call the assistant made for this carrier, read
          from the call log.
        </p>
      </div>

      {quiet ? (
        <Card>
          <EmptyState
            icon={<Cpu aria-hidden />}
            title="No model calls this week"
            body="Ask a question on Home. Each call it makes shows up here with its time and cost."
            action={
              <Link href="/" className={buttonVariants({ variant: "outline", size: "sm" })}>
                Go to Home
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Model calls" value={count(week.calls)} />
          <StatCard
            label="Spent"
            value={formatSpend(week.costNanocents)}
            hint={
              week.unsettled > 0
                ? `Plus ${formatSpend(week.heldNanocents)} held for ${countWords(week.unsettled, "call", "calls")} not settled`
                : undefined
            }
          />
          <StatCard
            label="Gateway checks"
            value={count(week.decisions.total)}
            hint={`${count(week.decisions.blocked)} blocked, ${count(week.decisions.refused)} refused`}
          />
          <StatCard
            label="Handed to Muse Wonder"
            value={count(week.escalations)}
            hint="Proposals Muse Spark could not form"
          />
        </div>
      )}

      {budget ? (
        <p className="text-small text-foreground-2">
          Demo budget used, across every carrier: {formatSpend(budget.spentNanocents)}
          {budget.capNanocents === null ? ", with no cap set, so every call is refused." : ` of ${formatSpend(budget.capNanocents)}.`}
        </p>
      ) : null}

      {cacheLine ? <p className="text-small text-foreground-2">{cacheLine}</p> : null}

      <section aria-labelledby="models-heading" className="grid gap-3">
        <h2 id="models-heading" className="text-h3 text-foreground">
          The models
        </h2>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {week.models.map((m) => (
            <ModelCard key={m.target} m={m} />
          ))}
        </div>
      </section>

      {quiet ? null : (
        <section aria-labelledby="checks-heading" className="grid gap-3">
          <h2 id="checks-heading" className="text-h3 text-foreground">
            Checks around the models
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            <Card className="min-w-0">
              <CardHeader>
                <div className="grid gap-0.5">
                  <CardTitle>Gateway</CardTitle>
                  <CardDescription>Every tool a model asks for passes here first.</CardDescription>
                </div>
              </CardHeader>
              <CardBody>
                <dl className="grid divide-y divide-border">
                  <Row label="Allowed" value={count(week.decisions.allowed)} />
                  <Row label="Blocked by a rule" value={count(week.decisions.blocked)} />
                  <Row label="Refused (wrong form, tool or role)" value={count(week.decisions.refused)} />
                  <Row label="Did not finish" value={count(week.decisions.failed)} />
                </dl>
              </CardBody>
            </Card>
            <Card className="min-w-0">
              <CardHeader>
                <div className="grid gap-0.5">
                  <CardTitle>Screening</CardTitle>
                  <CardDescription>Outside text is checked before the assistant reads it.</CardDescription>
                </div>
              </CardHeader>
              <CardBody>
                <dl className="grid divide-y divide-border">
                  <Row label="Clean" value={count(week.screenings.clean)} />
                  <Row label="Flagged" value={count(week.screenings.flagged)} />
                  <Row label="Checked by Muse Spark Open" value={count(week.screenings.byModel)} />
                  <Row label="Same text, earlier answer reused" value={count(week.screenings.byCache)} />
                  <Row label="Caught by a known pattern" value={count(week.screenings.byPattern)} />
                  <Row label="Screen did not finish (held as flagged)" value={count(week.screenings.errored)} />
                </dl>
              </CardBody>
            </Card>
          </div>
        </section>
      )}
    </div>
  );
}
