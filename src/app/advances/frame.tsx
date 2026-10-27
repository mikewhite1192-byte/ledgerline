import type { ReactNode } from "react";
import { appNav } from "@/components/app/app-nav";
import { AppShell } from "@/components/app/app-shell";
import { ErrorState } from "@/components/app/states";
import { Wordmark } from "@/components/brand/wordmark";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { Shell } from "@/lib/advances/read";
import { DbError } from "@/lib/db";
import { ForbiddenError } from "@/lib/tenant/context";

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

export function AdvanceFrame({ shell, title, children }: { shell: Shell; title: string; children: ReactNode }) {
  return (
    <AppShell
      tenant={{ name: shell.name, email: shell.email, timezone: shell.timezone }}
      nav={appNav("/advances")}
      title={title}
      signOut={signOut}
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
