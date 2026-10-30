import type { ReactNode } from "react";
import type { PageFocus } from "@/components/agent/page-focus";
import { Wordmark } from "@/components/brand/wordmark";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AppShell } from "./app-shell";
import { appNav, type NavKey } from "./app-nav";
import { ErrorState } from "./states";
import type { TenantInfo } from "./tenant-switcher";

export function SignOutForm() {
  return (
    <form action="/api/auth/sign-out" method="post">
      <Button type="submit" variant="ghost" className="w-full justify-start">
        Sign out
      </Button>
    </form>
  );
}

export type HelpLinkTarget = { href: string; label: string };

// The help link under the nav on every signed-in page: the plain-words tour of trucking pay.
export const HOW_PAY_WORKS: HelpLinkTarget = { href: "/help/how-pay-works", label: "How trucking pay works" };

// A signed-in page inside the shell, with the app's nav, the carrier chip and the help link (null
// leaves it off, as on the help page itself). A record's page passes `focus`, the record it read
// under the carrier, so the agent panel can ask about it; list pages pass none.
export function SignedInPage({
  tenant,
  current,
  title,
  help = HOW_PAY_WORKS,
  focus,
  children,
}: {
  tenant: TenantInfo;
  current: NavKey;
  title: string;
  help?: HelpLinkTarget | null;
  focus?: PageFocus;
  children: ReactNode;
}) {
  return (
    <AppShell
      tenant={tenant}
      nav={appNav(current)}
      title={title}
      help={help ?? undefined}
      signOut={<SignOutForm />}
      focus={focus}
    >
      <div className="mx-auto grid w-full max-w-[960px] min-w-0 gap-6">{children}</div>
    </AppShell>
  );
}

// No carrier to show a shell for (no membership, or the read failed): the problem by category
// and a way out. Unknown is not empty, so this never reads as "no data".
export function NoCarrierPage({ problem }: { problem: "forbidden" | "unreadable" }) {
  return (
    <main className="flex min-h-dvh flex-col items-center bg-background px-4 pt-16 pb-10 sm:pt-24">
      <div className="grid w-full max-w-[440px] gap-6">
        <h1 className="sr-only">LedgerLine</h1>
        <Wordmark size="lg" className="justify-self-center" />
        <Card>
          <ErrorState category={problem} />
          <div className="border-t border-border p-3">
            <SignOutForm />
          </div>
        </Card>
      </div>
    </main>
  );
}
