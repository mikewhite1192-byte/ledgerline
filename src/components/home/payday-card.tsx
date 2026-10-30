import { Money } from "@/components/app/money";
import { formatPeriod } from "@/lib/format/dates";
import type { Payday } from "@/lib/home/cards";
import type { Loaded } from "@/lib/home/loaded";
import { HomeCard, Nothing, Unavailable } from "./home-card";

const count = (n: number) => n.toLocaleString("en-US");

// This pay week's paystubs: how many were built, where they stand, and their net pay. A count of
// zero for waiting, approved or paid is shown, since "none approved yet" is the news.
export function PaydayCard({ payday, askHref }: { payday: Loaded<Payday>; askHref?: string }) {
  return (
    <HomeCard title="Paystubs" link={{ href: "/settlements", label: "Open settlements" }} askHref={askHref}>
      {!payday.ok ? (
        <Unavailable>Could not read this pay week&apos;s paystubs.</Unavailable>
      ) : payday.value.period === null ? (
        <Nothing>No pay week is open yet. Paystubs show here once one is.</Nothing>
      ) : (
        <PaydayBody payday={payday.value} />
      )}
    </HomeCard>
  );
}

function PaydayBody({ payday }: { payday: Payday }) {
  const period = payday.period ? formatPeriod(payday.period.start, payday.period.end) : null;
  if (payday.paystubs === 0) return <Nothing>No paystubs built for {period} yet.</Nothing>;
  const lines: { label: string; n: number; tone?: "warning" }[] = [
    { label: "waiting for your OK", n: payday.waiting },
    { label: "approved", n: payday.approved },
    { label: "paid", n: payday.paid },
  ];
  if (payday.problems > 0) lines.push({ label: "with a problem", n: payday.problems, tone: "warning" });
  if (payday.held > 0) lines.push({ label: "held back", n: payday.held, tone: "warning" });
  return (
    <>
      <div className="grid gap-0.5">
        <p className="text-small text-foreground-2">{period}</p>
        <p className="text-figure text-foreground">
          <Money cents={payday.netCents} />
        </p>
        <p className="text-small text-foreground-2">
          Net pay on {count(payday.paystubs)} {payday.paystubs === 1 ? "paystub" : "paystubs"}
        </p>
      </div>
      <ul aria-label="Where the paystubs stand" className="flex flex-wrap gap-x-5 gap-y-1">
        {lines.map((l) => (
          <li key={l.label} className={l.tone === "warning" ? "text-body text-warning" : "text-body text-foreground"}>
            <span className="font-semibold tabular-nums">{count(l.n)}</span> {l.label}
          </li>
        ))}
      </ul>
    </>
  );
}
