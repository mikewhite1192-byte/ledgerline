import type { ReactNode } from "react";
import type { PageFocus } from "@/components/agent/page-focus";
import { appNav } from "@/components/app/app-nav";
import { AppShell } from "@/components/app/app-shell";
import { PageHeader } from "@/components/app/page-header";
import { ErrorState, FeatureOff } from "@/components/app/states";
import { Wordmark } from "@/components/brand/wordmark";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { readShell, type Shell } from "@/lib/advances/read";
import { DbError } from "@/lib/db";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";

// The frame every advance page shares: the signed-in shell with the Advances item current, and
// the one way a page says its read failed. Unknown is not empty: a failed read never shows as
// "no advances".

export type ReadProblem = "forbidden" | "unreadable";

// A failed read's category, or a rethrow for anything that is not one (the sign-in redirect).
export function problemOf(err: unknown): ReadProblem {
  if (err instanceof ForbiddenError) return "forbidden";
  if (err instanceof DbError) return "unreadable";
  throw err;
}

const signOut = (
  <form action="/api/auth/sign-out" method="post">
    <Button type="submit" variant="ghost" className="w-full justify-start">
      Sign out
    </Button>
  </form>
);

// `focus` is set by the one advance's page, for the agent panel's chip.
export function AdvanceFrame({
  shell,
  title,
  focus,
  children,
}: {
  shell: Shell;
  title: string;
  focus?: PageFocus;
  children: ReactNode;
}) {
  return (
    <AppShell
      tenant={{ name: shell.name, email: shell.email, timezone: shell.timezone, role: shell.role }}
      nav={appNav("/advances")}
      title={title}
      signOut={signOut}
      focus={focus}
    >
      <div className="mx-auto grid w-full max-w-[960px] gap-6">{children}</div>
    </AppShell>
  );
}

export function ReadFailed({ problem }: { problem: ReadProblem }) {
  return (
    <main className="flex min-h-dvh flex-col items-center bg-background px-4 pt-16 pb-10 sm:pt-24">
      <div className="grid w-full max-w-[440px] gap-6">
        <h1 className="sr-only">LedgerLine</h1>
        <Wordmark size="lg" className="justify-self-center" />
        <Card>
          <ErrorState category={problem} />
          <div className="border-t border-border p-3">{signOut}</div>
        </Card>
      </div>
    </main>
  );
}

// An advance page while the advances switch is off: the shell, the page's title, and the off
// state. It reads only the carrier chip, never an advance.
export async function AdvancesOffPage({ title, description }: { title: string; description?: string }) {
  let shell: Shell | null = null;
  let problem: ReadProblem | null = null;
  try {
    shell = await withRequestTenant((q, session) => readShell(q, session));
  } catch (err) {
    problem = problemOf(err);
  }
  if (!shell) return <ReadFailed problem={problem ?? "unreadable"} />;
  return (
    <AdvanceFrame shell={shell} title={title}>
      <PageHeader title={title} description={description} />
      <FeatureOff name="Advances" plural />
    </AdvanceFrame>
  );
}
