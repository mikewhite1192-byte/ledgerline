import { BellDot, MessageCircle, Pin } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { AgentLauncher } from "@/components/agent/agent-launcher";
import type { AgentPanelConfig } from "@/components/agent/agent-panel";
import type { PageFocus } from "@/components/agent/page-focus";
import type { AgentOpening } from "@/components/agent/panel-context";
import { defaultSuggestions } from "@/components/agent/suggestions";
import { greetingLine } from "@/components/agent/words";
import { Wordmark } from "@/components/brand/wordmark";
import { flags, stepThroughShown } from "@/config/flags";
import { PlainModeProvider } from "@/components/trace/plain-mode";
import { cn } from "@/lib/cn";
import { NEEDS_YOU_ANCHOR } from "./anchors";
import { AreaTabs, type AreaTab } from "./area-tabs";
import { isVisitor } from "@/lib/visit-copy/visitor";
import { DemoBanner, VisitorNotice } from "./demo-banner";
import { MobileNav } from "./mobile-nav";
import { Money } from "./money";
import { MENU_AREAS, type MenuArea } from "./nav/menu-item";
import { NavList, navRowClass, type NavItem } from "./nav-list";
import type { Suggestion } from "./prompt-chips";
import { SectionNav } from "./section-nav";
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
    <div className="grid grid-cols-1 gap-1 border-t border-border pt-4">
      <p aria-hidden className="px-2.5 text-caption font-medium tracking-wide text-muted-foreground uppercase">
        Pinned
      </p>
      <ul aria-label="Pinned" className="grid grid-cols-1 gap-0.5">
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
  // One column no wider than the sidebar (minmax(0, 1fr)), so a long row truncates instead of
  // widening the column and pushing the area tabs past the edge.
  return (
    <div className="grid grid-cols-1 gap-4">
      {tabs.length > 0 ? <AreaTabs tabs={tabs} current={open} /> : null}
      <ul className="grid grid-cols-1 gap-0.5">
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
// holds the agent's box (it opens the card), the test-mode chip, the hide-amounts eye and the bell; the page itself is
// in <main id="main">, in a column 1150 px at most. The page's own PageHeader carries its one
// visible title (the h1); `title` names the main region for a screen reader. A demo visitor (the
// judge role) also gets the demo banner above the top bar. A nav with no areas (the /design
// specimen) shows as one flat list.
//
// While the agent switch is on, every page, Home included, also gets the agent launcher and its
// floating card. `focus` is the one record the page is about, for the card's chip, sent only while
// the page focus switch is on. `suggestions` are the card's questions (each page gets the default
// ones unless it passes its own, as Home does), and `agentOpening` asks the card to open as the
// page loads (Home's links). The public /design specimen passes agentPanel={false}. `askBox`
// false leaves the top bar's box out on a page that has its own (the simple Home).
//
// Under the simple shape (flags.simpleShape) the menu is the five-word SectionNav, with no
// Pinned amounts and no Needs you or Ask rows (the bell and the floating button do those jobs), and
// the top carries one notice, not three: a demo visitor's line (VisitorNotice) in place of both the
// test-mode line and the demo line, else the test-mode line; the top bar's test-mode chip goes.
// The plain trace's switch (flags.plainTrace) is handed to every trace panel and card under the
// shell, the agent's card included, through PlainModeProvider.
export function AppShell({
  tenant,
  nav,
  help,
  signOut,
  title,
  homeHref = "/",
  needsYouCount,
  pinned,
  focus,
  agentPanel = true,
  suggestions,
  agentOpening,
  askBox = true,
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
  focus?: PageFocus;
  agentPanel?: boolean;
  suggestions?: Suggestion[];
  agentOpening?: AgentOpening;
  askBox?: boolean;
  children: ReactNode;
}) {
  const testMode = testModeOnly();
  const agentOn = flags.agentEnabled === true;
  const panelOn = agentPanel && agentOn;
  const simple = flags.simpleShape.enabled === true;
  // A visit's own copy of the demo carrier (flags.visitCopies): the visit's banner, and no Demo
  // settings (a copy is never reset).
  const copy = flags.visitCopies.enabled === true && isVisitor(tenant);
  const visitor = tenant.role === "judge" || copy;
  const items = copy ? nav.filter((i) => i.href !== "/settings/demo") : nav;
  const list =
    simple && items.some((i) => i.section !== undefined) ? (
      <SectionNav nav={items} />
    ) : items.some((i) => i.area !== undefined) ? (
      <AreaNav nav={items} agentOn={agentOn} pinned={pinned} />
    ) : (
      <NavList items={items} />
    );
  // The one slot across the top. Off, the test-mode line sits there and a visitor's line sits
  // under it, above the top bar.
  const notice =
    simple && visitor ? (
      <VisitorNotice carrier={tenant.name} testMode={testMode} copy={copy} />
    ) : testMode ? (
      <TestModeBanner />
    ) : null;
  const offset = notice !== null;
  const shell = (
    <div className="min-h-dvh bg-background">
      <a
        href="#main"
        className="sr-only rounded-lg bg-card px-3 py-2 text-body font-medium text-foreground shadow-float focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50"
      >
        Skip to content
      </a>
      {notice}
      <div className="lg:flex">
        <aside
          className={cn(
            "z-30 hidden w-[250px] shrink-0 flex-col self-start border-r border-border bg-card lg:sticky lg:flex",
            offset ? "lg:top-9 lg:h-[calc(100dvh-2.25rem)]" : "lg:top-0 lg:h-dvh",
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
          {visitor && !simple ? <DemoBanner carrier={tenant.name} copy={copy} /> : null}
          <TopBar
            offset={offset}
            agentOn={agentOn}
            askBox={askBox}
            testMode={testMode && !simple}
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
  const plain = flags.plainTrace.enabled === true;
  if (!panelOn) return <PlainModeProvider plain={plain}>{shell}</PlainModeProvider>;
  return (
    <PlainModeProvider plain={plain}>
      <AgentLauncher
        config={panelConfig(tenant)}
        focus={flags.agentFocusEnabled === true ? focus : undefined}
        suggestions={suggestions ?? defaultSuggestions()}
        opening={agentOpening}
      >
        {shell}
      </AgentLauncher>
    </PlainModeProvider>
  );
}

// The card's settings, read here on the server. The greeting is worked out here too, so the
// browser is handed one finished line.
function panelConfig(tenant: TenantInfo): AgentPanelConfig {
  return {
    streamMode: flags.agentStreamMode,
    auditorOn: flags.auditorEnabled,
    stepThrough: stepThroughShown(),
    timezone: tenant.timezone,
    viewer: { admin: tenant.role === "admin", adminAboveCents: flags.approverRole.adminAboveCents },
    role: tenant.role,
    disabledReason: flags.aiEnabled ? undefined : "The models are switched off, so the agent cannot answer right now.",
    greeting: greetingLine(tenant.name),
    documentsHref: flags.documentsEnabled ? "/documents" : undefined,
    asksOn: flags.agentAsks.enabled === true,
    asksKey: tenant.asksKey,
  };
}
