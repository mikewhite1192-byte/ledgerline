import { Money } from "@/components/app/money";
import { formatPeriod } from "@/lib/format/dates";
import type { Owed } from "@/lib/home/cards";
import type { Loaded } from "@/lib/home/loaded";
import type { FlowWeek } from "@/lib/home/money-flow";
import { HomeCard, Nothing, Unavailable } from "./home-card";

export const IN_LABEL = "Customer payments in";
export const OUT_LABEL = "Paystubs paid out";

// The chart's drawing box. Bars stand on the baseline; the tallest week fills the height.
const W = 320;
const H = 112;
const BAR = 22;
const GAP = 2;

// A bar with 4 px rounded top corners, standing on the baseline.
function barPath(x: number, h: number): string {
  const r = Math.min(4, h, BAR / 2);
  const top = H - h;
  return `M${x},${H}V${top + r}Q${x},${top} ${x + r},${top}H${x + BAR - r}Q${x + BAR},${top} ${x + BAR},${top + r}V${H}Z`;
}

// Bars for money in and out per week, with the same figures listed under it for anyone who does
// not read the picture. The picture carries no amounts, so the hide-amounts eye loses nothing.
function FlowChart({ weeks }: { weeks: readonly FlowWeek[] }) {
  const max = Math.max(1, ...weeks.map((w) => Math.max(w.inCents, w.outCents)));
  const slot = W / weeks.length;
  const height = (cents: number) => (cents <= 0 ? 0 : Math.max(2, Math.round((cents / max) * (H - 4))));
  return (
    <svg viewBox={`0 0 ${W} ${H + 1}`} className="h-28 w-full" aria-hidden preserveAspectRatio="xMidYMax meet">
      {weeks.map((w, i) => {
        const x = i * slot + (slot - (BAR * 2 + GAP)) / 2;
        const inH = height(w.inCents);
        const outH = height(w.outCents);
        return (
          <g key={w.start}>
            <title>{formatPeriod(w.start, w.end)}</title>
            {inH > 0 ? <path d={barPath(x, inH)} className="fill-chart-in" /> : null}
            {outH > 0 ? <path d={barPath(x + BAR + GAP, outH)} className="fill-chart-out" /> : null}
          </g>
        );
      })}
      <line x1={0} x2={W} y1={H + 0.5} y2={H + 0.5} className="stroke-border" strokeWidth={1} />
    </svg>
  );
}

function Swatch({ className }: { className: string }) {
  return <span aria-hidden className={`inline-block size-2.5 shrink-0 rounded-sm ${className}`} />;
}

// Money in and out over the last few pay weeks: customer payments received and paystubs paid.
export function CashFlowCard({ flow, askHref }: { flow: Loaded<FlowWeek[]>; askHref?: string }) {
  return (
    <HomeCard title="Money in and out" askHref={askHref}>
      {!flow.ok ? (
        <Unavailable>Could not read money in and out.</Unavailable>
      ) : flow.value.length === 0 ? (
        <Nothing>No pay weeks yet. Money in and out shows here week by week.</Nothing>
      ) : (
        <FlowBody weeks={flow.value} />
      )}
    </HomeCard>
  );
}

function FlowBody({ weeks }: { weeks: FlowWeek[] }) {
  const totalIn = weeks.reduce((s, w) => s + w.inCents, 0);
  const totalOut = weeks.reduce((s, w) => s + w.outCents, 0);
  const span = `the last ${weeks.length === 1 ? "pay week" : `${weeks.length} pay weeks`}`;
  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-0.5">
          <p className="flex items-center gap-1.5 text-small text-foreground-2">
            <Swatch className="bg-chart-in" />
            {IN_LABEL}
          </p>
          <p className="text-figure text-foreground">
            <Money cents={totalIn} />
          </p>
        </div>
        <div className="grid gap-0.5">
          <p className="flex items-center gap-1.5 text-small text-foreground-2">
            <Swatch className="bg-chart-out" />
            {OUT_LABEL}
          </p>
          <p className="text-figure text-foreground">
            <Money cents={totalOut} />
          </p>
        </div>
      </div>
      <p className="text-small text-foreground-2">Over {span}.</p>
      <FlowChart weeks={weeks} />
      <ul aria-label="Money in and out by pay week" className="grid gap-1 border-t border-border pt-3">
        {weeks.map((w) => (
          <li key={w.start} className="flex flex-wrap items-baseline justify-between gap-x-4 text-small">
            <span className="text-foreground-2">{formatPeriod(w.start, w.end)}</span>
            <span className="text-foreground">
              In <Money cents={w.inCents} />, out <Money cents={w.outCents} />
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

// What customers owe: open balances, and how much of it is past its due date.
export function OwedCard({ owed, askHref }: { owed: Loaded<Owed>; askHref?: string }) {
  return (
    <HomeCard title="Owed to you" link={{ href: "/invoices?tab=invoices", label: "Open invoices" }} askHref={askHref}>
      {!owed.ok ? (
        <Unavailable>Could not read what customers owe.</Unavailable>
      ) : owed.value.invoices === 0 ? (
        <Nothing>No customer owes you money right now.</Nothing>
      ) : (
        <div className="grid gap-0.5">
          <p className="text-figure text-foreground">
            <Money cents={owed.value.owedCents} />
          </p>
          <p className="text-small text-foreground-2">
            On {owed.value.invoices.toLocaleString("en-US")} open {owed.value.invoices === 1 ? "invoice" : "invoices"}
          </p>
          <p className={owed.value.late > 0 ? "mt-2 text-body text-warning" : "mt-2 text-body text-foreground"}>
            {owed.value.late > 0 ? (
              <>
                <span className="font-semibold tabular-nums">{owed.value.late.toLocaleString("en-US")}</span> past
                due, <Money cents={owed.value.lateCents} tone="plain" />
              </>
            ) : (
              "None past due"
            )}
          </p>
        </div>
      )}
    </HomeCard>
  );
}
