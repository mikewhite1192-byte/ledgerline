import Link from "next/link";
import type { ReactNode } from "react";
import { InlineAlert } from "@/components/ui/inline-alert";
import { cn } from "@/lib/cn";
import { formatLocalDate, formatPeriod } from "@/lib/format/dates";
import { codeToWords, recordNamer } from "@/lib/format/labels";
import { paidUnderLine } from "@/lib/pay-rules/words";
import { hrefOrNull, recordHref, type HrefFor, type SourceRef } from "@/lib/records/href";
import { Money } from "./money";
import { StatusBadge } from "./status-badge";

// Structural, so the rules engine's PayLine fits as is (its Cents is a number, its table a name).
export type PaystubLine = {
  seq: number;
  kind: string;
  label: string;
  amountCents: number;
  sources: SourceRef[];
};

// The four totals must come from the rules engine's settlement result (settleDriver), never built by hand.
export type PaystubProps = {
  driver: { name: string; code: string; workerType: "company" | "owner_operator" };
  period: { start: string; end: string };
  status: string;
  lines: PaystubLine[];
  grossCents: number;
  deductionsCents: number;
  netCents: number;
  carryForwardCents: number;
  exceptions: { category: string; label: string; sources: SourceRef[] }[];
  hrefFor?: HrefFor;
  // When set, each line row gets the id `${lineIdPrefix}${seq}`, so a note can link to its line.
  lineIdPrefix?: string;
  // The pay rules version the week was paid under, by the date it started ("Paid under rules from
  // Oct 19"), linked to the Pay rules page when href is given (a staff screen, never a driver's).
  payRules?: { from: string; href?: string };
  className?: string;
};

const EARNINGS = new Set(["load_pay", "accessorial_pay", "reimbursement"]);
const WORKER = { company: "Company driver", owner_operator: "Owner-operator" } as const;

// The rules engine writes some line labels with a raw code or a stored date in them: "Reimbursement
// (lumper)", "Deduction (eld_fee)", "Advance recovery (2026-10-28)", "Accessorials, load BR-L10247".
// The engine stays as it is; the label reads in plain words here, where a person sees it. A label of
// any other shape shows as the engine wrote it.
const SUBKIND_WORDS: Record<string, string> = {
  lumper: "lumper fee",
  toll: "tolls",
  scale: "scale ticket",
  fuel: "fuel",
  correction: "pay correction",
  eld_fee: "ELD fee",
  cell_phone: "cell phone",
  plate_fee: "plate fee",
  cargo_claim: "cargo claim",
  shortfall: "shortfall",
};
const WITH_SUBKIND = /^(Reimbursement|Deduction|Fuel, company card|Shortfall carried from last week) \(([a-z0-9_]+)\)$/;
const RECOVERY = /^Advance recovery \((\d{4}-\d{2}-\d{2})\)$/;
const EXTRA_PAY = /^Accessorials, load (.+)$/;

export function lineDescription(label: string): string {
  const recovery = RECOVERY.exec(label);
  if (recovery) {
    try {
      return `Advance repaid (requested ${formatLocalDate(recovery[1])})`;
    } catch {
      return "Advance repaid";
    }
  }
  const extra = EXTRA_PAY.exec(label);
  if (extra) return `Extra pay, load ${extra[1]}`;
  const coded = WITH_SUBKIND.exec(label);
  if (coded) {
    const [, head, code] = coded;
    const words = Object.hasOwn(SUBKIND_WORDS, code) ? SUBKIND_WORDS[code] : codeToWords(code).toLowerCase();
    // "Fuel, company card (fuel)" and "Shortfall carried from last week (shortfall)" say it twice.
    return head.toLowerCase().includes(words) ? head : `${head}: ${words}`;
  }
  return label;
}

function LineLabel({ line, hrefFor }: { line: PaystubLine; hrefFor: HrefFor }) {
  const [first, ...rest] = line.sources;
  const label = lineDescription(line.label);
  const name = recordNamer(rest);
  if (!first) return <span className="text-foreground">{label}</span>;
  // A record the link rules do not know shows as its name, without a link.
  const href = hrefOrNull(hrefFor, first);
  return (
    <>
      {href ? (
        <Link href={href} className="text-foreground underline decoration-border underline-offset-4 hover:decoration-current">
          {label}
        </Link>
      ) : (
        <span className="text-foreground">{label}</span>
      )}
      {rest.length > 0 ? (
        <details className="group mt-0.5 text-small">
          <summary className="w-fit cursor-pointer list-none text-link underline-offset-4 hover:underline [&::-webkit-details-marker]:hidden">
            and {rest.length} more {rest.length === 1 ? "record" : "records"}
          </summary>
          <ul className="mt-1 grid gap-0.5">
            {rest.map((s) => {
              const restHref = hrefOrNull(hrefFor, s);
              return (
                <li key={`${s.table}:${s.id}`}>
                  {restHref ? (
                    <Link href={restHref} className="text-link underline-offset-4 hover:underline">
                      {name(s)}
                    </Link>
                  ) : (
                    <span className="text-foreground-2">{name(s)}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <tbody>
      <tr>
        <th scope="rowgroup" colSpan={2} className="pt-5 pb-1.5 text-left text-small font-semibold text-foreground-2">
          {title}
        </th>
      </tr>
      {children}
    </tbody>
  );
}

// The week's pay as the engine computed it, on one money rail: subtotals under a single rule,
// the net over a double rule. It adds nothing up; it shows the totals it is given.
export function Paystub({
  driver,
  period,
  status,
  lines,
  grossCents,
  deductionsCents,
  netCents,
  carryForwardCents,
  exceptions,
  hrefFor = recordHref,
  lineIdPrefix,
  payRules,
  className,
}: PaystubProps) {
  const bySeq = [...lines].sort((a, b) => a.seq - b.seq);
  const earnings = bySeq.filter((l) => EARNINGS.has(l.kind));
  const deductions = bySeq.filter((l) => !EARNINGS.has(l.kind));
  const row = (l: PaystubLine) => (
    <tr
      key={l.seq}
      id={lineIdPrefix ? `${lineIdPrefix}${l.seq}` : undefined}
      className="scroll-mt-20 align-baseline target:bg-secondary"
    >
      <td className="py-1.5 pr-4 text-body">
        <LineLabel line={l} hrefFor={hrefFor} />
      </td>
      <td className="py-1.5 text-right text-body whitespace-nowrap">
        <Money cents={l.amountCents} />
      </td>
    </tr>
  );

  return (
    <section
      aria-label={`Paystub for ${driver.name}, ${formatPeriod(period.start, period.end)}`}
      className={cn("rounded-lg border border-border bg-card px-4 py-4 text-card-foreground sm:px-6 sm:py-5", className)}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 className="text-h3 text-foreground">{driver.name}</h3>
          <p className="text-small text-foreground-2">
            {driver.code}, {WORKER[driver.workerType]}
          </p>
          <p className="mt-0.5 text-small text-foreground-2">Pay period {formatPeriod(period.start, period.end)}</p>
          {payRules ? (
            <p className="mt-0.5 text-small text-foreground-2">
              {payRules.href ? (
                <Link href={payRules.href} className="text-link underline-offset-4 hover:underline">
                  {paidUnderLine(payRules.from)}
                </Link>
              ) : (
                paidUnderLine(payRules.from)
              )}
            </p>
          ) : null}
        </div>
        <StatusBadge status={status} />
      </header>

      {exceptions.length > 0 ? (
        <div className="mt-4 grid gap-2">
          {exceptions.map((x, i) => {
            const name = recordNamer(x.sources);
            return (
              <InlineAlert key={`${x.category}:${i}`} tone="warning" title={x.label}>
                <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-small">
                  {x.sources.map((s) => {
                    const href = hrefOrNull(hrefFor, s);
                    return href ? (
                      <Link key={`${s.table}:${s.id}`} href={href} className="text-foreground underline underline-offset-4">
                        {name(s)}
                      </Link>
                    ) : (
                      <span key={`${s.table}:${s.id}`} className="text-foreground">
                        {name(s)}
                      </span>
                    );
                  })}
                </span>
              </InlineAlert>
            );
          })}
        </div>
      ) : null}

      <table className="mt-1 w-full border-collapse">
        <caption className="sr-only">
          Earnings, deductions and net pay for {driver.name}, {formatPeriod(period.start, period.end)}
        </caption>
        <colgroup>
          <col />
          <col className="w-[8.5rem]" />
        </colgroup>
        <Group title="Earnings">
          {earnings.map(row)}
          <tr className="align-baseline">
            <th scope="row" className="pt-2 pb-1 pr-4 text-left text-body font-semibold text-foreground">
              Gross pay
            </th>
            <td className="rule-single pt-2 pb-1 text-right text-body font-semibold whitespace-nowrap">
              <Money cents={grossCents} />
            </td>
          </tr>
        </Group>
        <Group title="Deductions">
          {deductions.map(row)}
          <tr className="align-baseline">
            <th scope="row" className="pt-2 pb-1 pr-4 text-left text-body font-semibold text-foreground">
              Total deductions
            </th>
            <td className="rule-single pt-2 pb-1 text-right text-body font-semibold whitespace-nowrap">
              <Money cents={-Math.abs(deductionsCents)} />
            </td>
          </tr>
        </Group>
        <tbody>
          {carryForwardCents !== 0 ? (
            // The engine carries the shortfall as a positive add-back, so "+" sums down the rail;
            // the caption says where it comes back from.
            <tr className="align-baseline">
              <th scope="row" className="pt-4 pr-4 text-left text-body font-normal text-foreground">
                <span className="block">Shortfall carried to next period</span>
                <span className="mt-0.5 block text-caption text-foreground-2">Taken from next period&apos;s pay.</span>
              </th>
              <td className="pt-4 text-right text-body whitespace-nowrap">
                <Money cents={carryForwardCents} sign="always" />
              </td>
            </tr>
          ) : null}
          <tr className="align-baseline">
            <th scope="row" className="pt-5 pr-4 text-left text-h3 text-foreground">
              Net pay
            </th>
            <td className="rule-double pt-5 pb-1 text-right text-figure whitespace-nowrap text-foreground" data-testid="net-pay">
              <Money cents={netCents} tone="plain" />
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
