import Link from "next/link";
import { Money } from "@/components/app/money";
import { Card } from "@/components/ui/card";
import type { NeedsYouView } from "@/lib/home/needs-you";

// "Needs you" at the top of Home, drawn from what src/lib/home/needs-you.ts read on the server.
// Amounts are integer cents, shown by the shared formatter. A count cut off at its read's limit
// reads "or more", and its total "At least", since it sums only the rows read. A read that failed
// never shows as "nothing is waiting".

export const NEEDS_YOU_EMPTY = "Nothing is waiting on you. Ask a question or open a page from the menu.";
export const NEEDS_YOU_UNREAD = "Could not check everything that is waiting right now. Reload the page to try again.";

export function NeedsYou({ view }: { view: NeedsYouView }) {
  const { rows, unread } = view;
  return (
    <section aria-labelledby="needs-you-title" className="mx-auto w-full max-w-[720px]">
      <Card>
        <h2 id="needs-you-title" className="px-4 pt-4 text-h3 text-foreground sm:px-5">
          Needs you
        </h2>
        {rows.length > 0 ? (
          <ul aria-label="Waiting on you" className="mt-2 divide-y divide-border border-t border-border">
            {rows.map((r) => (
              <li
                key={r.key}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-5"
              >
                <p className="min-w-0 text-body text-foreground">
                  <span className="font-semibold tabular-nums">
                    {r.atLeast ? `${r.count.toLocaleString("en-US")} or more` : r.count.toLocaleString("en-US")}
                  </span>{" "}
                  {r.what}
                  {r.amounts.map((a) => (
                    <span key={a.label} className="block text-small text-foreground-2">
                      {r.atLeast ? "At least " : null}
                      <Money cents={a.cents} tone="plain" /> {a.label}
                    </span>
                  ))}
                </p>
                {r.href.startsWith("#") ? (
                  <a href={r.href} className="text-small text-link underline-offset-4 hover:underline">
                    {r.linkLabel}
                  </a>
                ) : (
                  <Link href={r.href} className="text-small text-link underline-offset-4 hover:underline">
                    {r.linkLabel}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {unread ? (
          <p role="status" className="px-4 pt-2 pb-4 text-body text-foreground-2 sm:px-5">
            {NEEDS_YOU_UNREAD}
          </p>
        ) : rows.length === 0 ? (
          <p className="px-4 pt-1 pb-4 text-body text-foreground-2 sm:px-5">{NEEDS_YOU_EMPTY}</p>
        ) : null}
      </Card>
    </section>
  );
}
