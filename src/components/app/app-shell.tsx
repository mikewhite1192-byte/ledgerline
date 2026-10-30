import Link from "next/link";
import type { ReactNode } from "react";
import { Wordmark } from "@/components/brand/wordmark";
import { flags } from "@/config/flags";
import { DemoBanner } from "./demo-banner";
import { MobileNav } from "./mobile-nav";
import { NavList, type NavItem } from "./nav-list";
import { TenantSwitcher, type TenantInfo } from "./tenant-switcher";
import { ViewerRoleProvider } from "./viewer-role";

export type { NavItem };

function HelpLink({ help }: { help: { href: string; label: string } }) {
  return (
    <Link href={help.href} className="text-body text-foreground-2 underline-offset-4 hover:text-foreground hover:underline">
      {help.label}
    </Link>
  );
}

// Every signed-in page: a sidebar at laptop width (a sheet behind the menu button under it), a top
// bar with the current menu group ("Pay", nothing on a page with no item) and the carrier chip at
// the right, and the page itself in <main id="main">. The page's own PageHeader carries its one
// visible title (the h1); `title` names the main region for a screen reader. A demo visitor (the
// judge role) also gets the demo banner above the top bar.
export function AppShell({
  tenant,
  nav,
  help,
  signOut,
  title,
  homeHref = "/",
  children,
}: {
  tenant: TenantInfo;
  nav: NavItem[];
  help?: { href: string; label: string };
  signOut: ReactNode;
  title: string;
  homeHref?: string;
  children: ReactNode;
}) {
  const list = <NavList items={nav} />;
  const group = nav.find((item) => item.current)?.group;
  return (
    <div className="min-h-dvh bg-background">
      <a
        href="#main"
        className="sr-only rounded-lg bg-card px-3 py-2 text-body font-medium text-foreground shadow-float focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50"
      >
        Skip to content
      </a>
      <aside className="fixed inset-y-0 left-0 z-10 hidden w-60 flex-col border-r border-border bg-card lg:flex">
        <div className="flex h-14 items-center px-5">
          <Link href={homeHref} aria-label="LedgerLine home" className="rounded-md">
            <Wordmark size="sm" />
          </Link>
        </div>
        <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-2">
          {list}
        </nav>
        {help ? (
          <div className="border-t border-border px-5 py-4">
            <HelpLink help={help} />
          </div>
        ) : null}
      </aside>
      <div className="lg:pl-60">
        {tenant.role === "judge" ? (
          <DemoBanner carrier={tenant.name} visitCapCents={flags.judgeAccess.sessionCapCents} />
        ) : null}
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur-sm md:px-6">
          <MobileNav homeHref={homeHref} help={help ? <HelpLink help={help} /> : null}>
            {list}
          </MobileNav>
          {group ? <p className="min-w-0 flex-1 truncate text-body font-medium text-foreground-2">{group}</p> : null}
          <div className="ml-auto shrink-0">
            <TenantSwitcher tenant={tenant} signOut={signOut} />
          </div>
        </header>
        <main id="main" tabIndex={-1} aria-label={title} className="px-4 py-6 outline-none md:px-6 md:py-8">
          <ViewerRoleProvider role={tenant.role}>{children}</ViewerRoleProvider>
        </main>
      </div>
    </div>
  );
}
