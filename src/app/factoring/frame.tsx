import type { ReactNode } from "react";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { FeatureOff } from "@/components/app/states";
import { DbError } from "@/lib/db";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { readShell, type ShellTenant } from "@/lib/tenant/shell";

// What the factoring pages share: the one way a read fails, and the page while the switch is off.
// Unknown is not empty: a failed read never shows as "no invoices factored".

export type ReadProblem = "forbidden" | "unreadable";

// A failed read's category, or a rethrow for anything that is not one (the sign-in redirect).
export function problemOf(err: unknown): ReadProblem {
  if (err instanceof ForbiddenError) return "forbidden";
  if (err instanceof DbError) return "unreadable";
  throw err;
}

export const DESCRIPTION =
  "Invoices sold to the factoring partner for cash now. The partner pays most of each invoice now, takes a fee, and holds the rest back until your customer pays.";

// A factoring page while the switch is off: the shell, the title and the off state. It reads only
// the carrier chip, never a request.
export async function FactoringOffPage({ title }: { title: string }) {
  let shell: ShellTenant | null = null;
  let problem: ReadProblem | null = null;
  try {
    shell = await withRequestTenant((q, session) => readShell(q, session));
  } catch (err) {
    problem = problemOf(err);
  }
  if (!shell) return <NoCarrierPage problem={problem ?? "unreadable"} />;
  return (
    <FactoringFrame shell={shell} title={title}>
      <PageHeader title={title} description={DESCRIPTION} />
      <FeatureOff name="Factoring" />
    </FactoringFrame>
  );
}

export function FactoringFrame({ shell, title, children }: { shell: ShellTenant; title: string; children: ReactNode }) {
  return (
    <SignedInPage tenant={shell} current="/factoring" title={title}>
      {children}
    </SignedInPage>
  );
}
