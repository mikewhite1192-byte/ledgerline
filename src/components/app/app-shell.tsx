import { BellDot, MessageCircle, Pin } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Wordmark } from "@/components/brand/wordmark";
import { flags } from "@/config/flags";
import { cn } from "@/lib/cn";
import { NEEDS_YOU_ANCHOR } from "./anchors";
import { AreaTabs, type AreaTab } from "./area-tabs";
import { DemoBanner } from "./demo-banner";
import { MobileNav } from "./mobile-nav";
import { Money } from "./money";
import { MENU_AREAS, type MenuArea } from "./nav/menu-item";
import { NavList, navRowClass, type NavItem } from "./nav-list";
import { AccountParts, CarrierTile, TenantSwitcher, type TenantInfo } from "./tenant-switcher";
import { TestModeBanner, testModeOnly } from "./test-mode-banner";
import { AskLink, TopBar } from "./top-bar";
import { ViewerRoleProvider } from "./viewer-role";

export type { NavItem };

// The two amounts the sidebar keeps in view, in cents. A page that has not read one leaves it
// out, and its line shows as a plain link.
export type PinnedAmounts = { payWeekCents?: number; dueCents?: number };

function HelpLink({ help }: { help: { href: string; label: string } }) {
  return (
    <Link
      href={help.href}
      className="text-body text-foreground-2 underline-offset-4 hover:text-foreground hover:underline"
    >
      {help.label}
    </Link>
  );
}

// An item with no area (none in the app's own menu today) belongs to Books.
function areaOf(item: NavItem): MenuArea | "primary" {
  return item.area ?? "books";
}

// Two fixed lines under the area's pages: this pay week's settlements and what customers owe, each
// to its page while that page is on, with the amount when the page passed one in.
function Pinned({ nav, amounts }: { nav: NavItem[]; amounts?: PinnedAmounts }) {
  const payWeek = nav.find((i) => i.href === "/settlements");
  const due = nav.find((i) => i.href === "/collections") ?? nav.find((i) => i.href === "/invoices");
  const lines = [
    payWeek
      ? {
          label: "This pay week",
          href: payWeek.href,
          cents: amounts?.payWeekCents,
        }
      : null,
    due
      ? {
          label: "Due from customers",
          href: due.href,
          cents: amounts?.dueCents,
        }
      : null,
  ].filter((l) => l !== null);
  if (lines.length === 0) return null;
  return (
    <div className="grid gap-1 border-t border-border pt-4">
      <p aria-hidden className="px-2.5 text-caption font-medium tracking-wide text-muted-foreground uppercase">
        Pinned
      </p>
      <ul aria-label="Pinned" className="grid gap-0.5">
        {lines.map((l) => (
          <li key={l.label}>
            <Link href={l.href} className={navRowClass()}>
              <Pin aria-hidden />
              <span className="min-w-0 flex-1 truncate">{l.label}</span>
              {l.cents !== undefined ? <Money cents={l.cents} className="text-small text-foreground-2" /> : null}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

// The menu for both the sidebar and the phone sheet: the area tabs, the rows every page has (Home,
// Needs you, and Ask while the agent is on), then the open area's pages by group, then Pinned.
// The open area is the current page's; a page with no item of its own (a record page) opens Pay.
function AreaNav({ nav, agentOn, pinned }: { nav: NavItem[]; agentOn: boolean; pinned?: PinnedAmounts }) {
  const here = nav.find((i) => i.current);
  const tabs: AreaTab[] = MENU_AREAS.flatMap((area) => {
    const first = nav.find((i) => areaOf(i) === area);
    return first ? [{ area, href: first.href }] : [];
  });
  const hereArea = here ? areaOf(here) : "primary";
  const wanted: MenuArea = hereArea === "primary" ? "pay" : hereArea;
  const open = tabs.some((t) => t.area === wanted) ? wanted : (tabs[0]?.area ?? wanted);
  const primary = nav.filter((i) => areaOf(i) === "primary");
  const pages = nav.filter((i) => areaOf(i) === open);
  return (
    <div className="grid gap-4">
      {tabs.length > 0 ? <AreaTabs tabs={tabs} current={open} /> : null}
      <ul className="grid gap-0.5">
        {primary.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={item.current ? "page" : undefined}
              className={navRowClass(item.current)}
            >
              {item.icon}
              {item.label}
            </Link>
          </li>
        ))}
        <li>
          <Link href={`/#${NEEDS_YOU_ANCHOR}`} className={navRowClass()}>
            <BellDot aria-hidden />
            Needs you
          </Link>
        </li>
        {agentOn ? (
          <li>
            <AskLink className={navRowClass()}>
              <MessageCircle aria-hidden />
              Ask
            </AskLink>
          </li>
        ) : null}
      </ul>
      {pages.length > 0 ? (
        <div className="border-t border-border pt-4">
          <NavList items={pages} />
        </div>
      ) : null}
      <Pinned nav={nav} amounts={pinned} />
    </div>
  );
}

// Every signed-in page. While payouts and postings are test-only, the test-mode banner runs across
// the top. Under it, at laptop width, the sidebar (a sheet behind the menu button under it): the
// carrier menu on top, then the menu (AreaNav), then the help link and the wordmark. The top bar
// holds the agent's box, the test-mode chip, the hide-amounts eye and the bell; the page itself is
// in <main id="main">, in a column 1150 px at most. The page's own PageHeader carries its one
// visible title (the h1); `title` names the main region for a screen reader. A demo visitor (the
// judge role) also gets the demo banner above the top bar. A nav with no areas (the /design
// specimen) shows as one flat list.
export function AppShell({
  tenant,
  nav,
  help,
  signOut,
  title,
  homeHref = "/",
  needsYouCount,
  pinned,
  children,
}: {
  tenant: TenantInfo;
  nav: NavItem[];
  help?: { href: string; label: string };
  signOut: ReactNode;
  title: string;
  homeHref?: string;
  // How many Needs you rows wait, from a page that read them (Home); the bell shows a dot.
  needsYouCount?: number;
  pinned?: PinnedAmounts;
  children: ReactNode;
}) {
  const testMode = testModeOnly();
  const agentOn = flags.agentEnabled === true;
  const list = nav.some((i) => i.area !== undefined) ? (
    <AreaNav nav={nav} agentOn={agentOn} pinned={pinned} />
  ) : (
    <NavList items={nav} />
  );
  return (
    <div className="min-h-dvh bg-background">
      <a
        href="#main"
        className="sr-only rounded-lg bg-card px-3 py-2 text-body font-medium text-foreground shadow-float focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50"
      >
        Skip to content
      </a>
      {testMode ? <TestModeBanner /> : null}
      <div className="lg:flex">
        <aside
          className={cn(
            "z-30 hidden w-[250px] shrink-0 flex-col self-start border-r border-border bg-card lg:sticky lg:flex",
            testMode ? "lg:top-9 lg:h-[calc(100dvh-2.25rem)]" : "lg:top-0 lg:h-dvh",
          )}
        >
          <div className="px-3 pt-3 pb-2">
            <TenantSwitcher tenant={tenant} signOut={signOut} />
          </div>
          <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {list}
          </nav>
          <div className="grid gap-3 border-t border-border px-5 py-4">
            {help ? <HelpLink help={help} /> : null}
            <Link href={homeHref} aria-label="LedgerLine home" className="justify-self-start rounded-md">
              <Wordmark size="sm" />
            </Link>
          </div>
        </aside>
        <div className="min-w-0 flex-1">
          {tenant.role === "judge" ? (
            <DemoBanner carrier={tenant.name} visitCapCents={flags.judgeAccess.sessionCapCents} />
          ) : null}
          <TopBar
            offset={testMode}
            agentOn={agentOn}
            testMode={testMode}
            needsYouCount={needsYouCount}
            menu={
              <MobileNav
                homeHref={homeHref}
                help={help ? <HelpLink help={help} /> : null}
                top={<CarrierTile tenant={tenant} />}
                bottom={<AccountParts tenant={tenant} signOut={signOut} />}
              >
                {list}
              </MobileNav>
            }
          />
          <main id="main" tabIndex={-1} aria-label={title} className="px-4 py-6 outline-none md:px-6 md:py-8">
            <div className="mx-auto w-full max-w-[1150px] min-w-0">
              <ViewerRoleProvider role={tenant.role}>{children}</ViewerRoleProvider>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
