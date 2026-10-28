import Link from "next/link";
import type { ReactNode } from "react";
import { Money } from "@/components/app/money";
import { Term } from "@/components/app/term";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { formatPeriod } from "@/lib/format/dates";
import { formatCents } from "@/lib/format/money";
import {
  EXAMPLE_LOAD,
  HERO_ADVANCE,
  HERO_CARRIER,
  HERO_DRIVER,
  HERO_INSURANCE,
  HERO_LINES,
  HERO_LOADS,
  HERO_PERIOD,
  HERO_TOTALS,
  type HeroLine,
} from "@/lib/help/hero-week";

// "How trucking pay works": five short blocks, each about one phone screen, told with one
// fictional driver's real demo week. Every number comes from src/lib/help/hero-week.ts, which a
// test holds equal to the seed. This component reads nothing; the page decides whether to pass the
// signed-in link to her paystub.

export type HeroPaystubLink = { href: string; draft: boolean } | null;

const SUBKIND_WORDS: Readonly<Record<string, string>> = { toll: "tolls", fuel: "fuel" };

// One line of her week, in plain words with the help on each pay word.
function lineWords(line: HeroLine): ReactNode {
  switch (line.kind) {
    case "load_pay": {
      const load = HERO_LOADS.find((l) => `Load ${l.loadNumber}` === line.engineLabel);
      return (
        <>
          {line.engineLabel}
          {load ? (
            <span className="block text-small text-foreground-2">
              {HERO_DRIVER.percentOfLinehaul}% of {formatCents(load.linehaulCents)} <Term id="linehaul">linehaul</Term>
            </span>
          ) : null}
        </>
      );
    }
    case "reimbursement": {
      const sub = /\(([a-z_]+)\)$/.exec(line.engineLabel)?.[1] ?? "";
      return (
        <>
          <Term id="reimbursement">Reimbursement</Term>: {SUBKIND_WORDS[sub] ?? sub.replace(/_/g, " ")}
        </>
      );
    }
    case "insurance":
      return (
        <>
          <Term id="insurance">Insurance</Term>, {HERO_INSURANCE.days} days
          <span className="block text-small text-foreground-2">{formatCents(HERO_INSURANCE.perDayCents)} for each day driven</span>
        </>
      );
    case "escrow":
      return (
        <>
          <Term id="escrow">Escrow</Term>
          <span className="block text-small text-foreground-2">Held back, returned when her lease ends</span>
        </>
      );
    case "advance_recovery":
      return (
        <>
          <Term id="advance-repaid">Advance repaid</Term>
          <span className="block text-small text-foreground-2">
            The {formatCents(HERO_ADVANCE.amountCents)} <Term id="advance">advance</Term> she asked for on {HERO_ADVANCE.weekday}
          </span>
        </>
      );
  }
}

function Block({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-3 rounded-lg border border-border bg-card px-4 py-5 text-card-foreground sm:px-6">
      <h2 id={`${id}-title`} className="text-h3 text-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function AmountRow({ label, cents, strong = false }: { label: ReactNode; cents: number; strong?: boolean }) {
  return (
    <tr className="align-baseline">
      <th scope="row" className={strong ? "pt-2 pr-4 text-left text-body font-semibold text-foreground" : "py-1.5 pr-4 text-left text-body font-normal text-foreground"}>
        {label}
      </th>
      <td className={strong ? "rule-single pt-2 text-right text-body font-semibold whitespace-nowrap" : "py-1.5 text-right text-body whitespace-nowrap"}>
        <Money cents={cents} tone="plain" />
      </td>
    </tr>
  );
}

export function HowPayWorks({ paystub, signedIn }: { paystub: HeroPaystubLink; signedIn: boolean }) {
  const earnings = HERO_LINES.filter((l) => l.amountCents > 0);
  const deductions = HERO_LINES.filter((l) => l.amountCents < 0);
  const week = formatPeriod(HERO_PERIOD.start, HERO_PERIOD.end);
  return (
    <div className="grid gap-4">
      <Block id="business" title="The business">
        <p className="text-lead text-foreground">
          A trucking company is paid by customers to haul loads, and it pays the drivers who haul them.
        </p>
      </Block>

      <Block id="money-in" title="Money in: a load becomes an invoice">
        <p className="text-body text-foreground-2">
          A delivered load becomes a customer invoice. Load {EXAMPLE_LOAD.loadNumber} went from {EXAMPLE_LOAD.origin} to{" "}
          {EXAMPLE_LOAD.destination}, {EXAMPLE_LOAD.loadedMiles} <Term id="loaded-miles">loaded miles</Term>.
        </p>
        <table className="w-full border-collapse">
          <caption className="sr-only">What the customer is billed for load {EXAMPLE_LOAD.loadNumber}</caption>
          <tbody>
            <AmountRow label={<Term id="linehaul">Linehaul</Term>} cents={EXAMPLE_LOAD.linehaulCents} />
            <AmountRow label={<Term id="fuel-surcharge">Fuel surcharge</Term>} cents={EXAMPLE_LOAD.fuelSurchargeCents} />
            <AmountRow label="Invoiced to the customer" cents={EXAMPLE_LOAD.invoiceCents} strong />
          </tbody>
        </table>
      </Block>

      <Block id="money-out" title="Money out: a driver's week becomes a paystub">
        <p className="text-body text-foreground-2">
          Every Friday, each driver&apos;s week becomes a paystub. {HERO_DRIVER.name} is an{" "}
          <Term id="owner-operator">owner-operator</Term> at {HERO_CARRIER}, a fictional carrier in the demo, paid{" "}
          {HERO_DRIVER.percentOfLinehaul}% of each load&apos;s linehaul. Her week of {week}:
        </p>
        <table className="w-full border-collapse">
          <caption className="sr-only">
            {HERO_DRIVER.name}&apos;s pay for {week}
          </caption>
          <colgroup>
            <col />
            <col className="w-[7.5rem]" />
          </colgroup>
          <tbody>
            {earnings.map((l) => (
              <AmountRow key={l.seq} label={lineWords(l)} cents={l.amountCents} />
            ))}
            <AmountRow label={<Term id="gross-pay">Gross pay</Term>} cents={HERO_TOTALS.grossCents} strong />
          </tbody>
          <tbody>
            <tr>
              <td colSpan={2} className="h-3" />
            </tr>
            {deductions.map((l) => (
              <AmountRow key={l.seq} label={lineWords(l)} cents={l.amountCents} />
            ))}
            <AmountRow label={<Term id="deductions">Deductions</Term>} cents={-HERO_TOTALS.deductionsCents} strong />
          </tbody>
          <tbody>
            <tr className="align-baseline">
              <th scope="row" className="pt-5 pr-4 text-left text-h3 text-foreground">
                <Term id="net-pay">Net pay</Term>
              </th>
              <td className="rule-double pt-5 text-right text-h3 whitespace-nowrap">
                <Money cents={HERO_TOTALS.netCents} tone="plain" />
              </td>
            </tr>
          </tbody>
        </table>
        {paystub ? (
          <div className="grid gap-1 pt-1">
            <Link href={paystub.href} className={cn(buttonVariants({ variant: "primary" }), "w-fit")}>
              {paystub.draft ? "See her paystub" : "See her paystubs"}
            </Link>
            {paystub.draft ? null : (
              <p className="text-small text-foreground-2">
                This week&apos;s paystub is drafted when you run the week on Settlements.
              </p>
            )}
          </div>
        ) : null}
      </Block>

      <Block id="why-it-breaks" title="Why it breaks">
        <p className="text-body text-foreground-2">
          The numbers live in the dispatch system, the fuel cards, text messages, spreadsheets and QuickBooks. One advance
          logged twice leaves a driver {formatCents(HERO_ADVANCE.amountCents)} short on Friday.
        </p>
      </Block>

      <Block id="what-it-does" title="What LedgerLine does">
        <p className="text-body text-foreground-2">
          It reads all of it, finds the problems, explains each one, and proposes the fix. A person approves. Only then is
          anything paid or sent.
        </p>
        {signedIn ? null : (
          <div className="pt-1">
            <Link href="/sign-in" className={cn(buttonVariants({ variant: "primary" }), "w-fit")}>
              Sign in to try the demo
            </Link>
          </div>
        )}
      </Block>
    </div>
  );
}

// The one line on Home that points a first-time reader at the page above.
export function NewHereLine() {
  return (
    <p className="mx-auto w-full max-w-[720px] text-body text-foreground-2">
      New here?{" "}
      <Link href="/help/how-pay-works" className="text-link underline-offset-4 hover:underline">
        How trucking pay works
      </Link>
    </p>
  );
}
