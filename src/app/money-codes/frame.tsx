import type { ReactNode } from "react";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { FeatureOff } from "@/components/app/states";
import { Term } from "@/components/app/term";
import { Badge } from "@/components/ui/badge";
import { DbError } from "@/lib/db";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { readShell, type ShellTenant } from "@/lib/tenant/shell";

// The frame every money code page shares: the signed-in shell with Money codes current, the Test
// mode badge, and the one way a page says its read failed or that the switch is off.

export type CodesProblem = "forbidden" | "unreadable";

// A failed read's category, or a rethrow for anything that is not one (the sign-in redirect).
export function codesProblemOf(err: unknown): CodesProblem {
  if (err instanceof ForbiddenError) return "forbidden";
  if (err instanceof DbError) return "unreadable";
  throw err;
}

export const CODES_HELP = (
  <>
    A one-time <Term id="money-code">code</Term> the driver gives a <Term id="lumper">lumper</Term> or a repair shop. It
    is charged to the driver&apos;s week and reimbursed by the receipt, so the driver&apos;s pay does not change.
  </>
);

export function CodesTitle({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-3">
      {children}
      <Badge tone="neutral">Test mode</Badge>
    </span>
  );
}

export function CodesFrame({ shell, title, children }: { shell: ShellTenant; title: string; children: ReactNode }) {
  return (
    <SignedInPage tenant={shell} current="/money-codes" title={title}>
      {children}
    </SignedInPage>
  );
}

// A money code page while the switch is off: the shell, the page's title and the off state. It
// reads only the carrier chip, never a code.
export async function CodesOffPage({ title }: { title: string }) {
  let shell: ShellTenant | null = null;
  let problem: CodesProblem | null = null;
  try {
    shell = await withRequestTenant((q, session) => readShell(q, session));
  } catch (err) {
    problem = codesProblemOf(err);
  }
  if (!shell) return <NoCarrierPage problem={problem ?? "unreadable"} />;
  return (
    <CodesFrame shell={shell} title={title}>
      <PageHeader title={title} />
      <FeatureOff name="Money codes" plural />
    </CodesFrame>
  );
}
