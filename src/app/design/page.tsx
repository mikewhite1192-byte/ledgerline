import { readFileSync } from "node:fs";
import path from "node:path";
import {
  Banknote,
  Bell,
  Building2,
  CircleDashed,
  ClipboardCheck,
  LayoutGrid,
  Link2,
  MessagesSquare,
  MousePointerClick,
  Palette,
  PanelLeft,
  Receipt,
  Shapes,
  Table as TableIcon,
  Tag,
  TextCursorInput,
  Type,
} from "lucide-react";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app/app-shell";
import { DataTable } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { Paystub } from "@/components/app/paystub";
import { StatCard } from "@/components/app/stat-card";
import { EmptyState, ERROR_CATEGORIES, ErrorState, LoadingState } from "@/components/app/states";
import { BADGE_STATUSES, StatusBadge } from "@/components/app/status-badge";
import { TenantPanel } from "@/components/app/tenant-switcher";
import { Mark } from "@/components/brand/mark";
import { Wordmark } from "@/components/brand/wordmark";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { contrastRatio } from "@/lib/design/contrast";
import { isHex, parseTokens, type TokenSet } from "@/lib/design/tokens";
import { recordLabel, sourceLabel } from "@/lib/format/labels";
import { ChatDemo, ProposalGallery, SheetDemo, ToastDemo, ToastsAtRest } from "./demos";
import { LOADS, PAYSTUB, SAMPLE_TENANT, SOURCE_ROWS } from "./sample-data";
import { anchorFor, loadColumns } from "./shared";

// The design review: every piece of the interface in both modes, with invented sample data.
// Public and static; it reads no session, tenant, database or model.
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Design review",
  robots: { index: false, follow: false },
};

type Mode = "light" | "dark";

const SECTIONS = [
  { id: "identity", label: "Identity", icon: <Shapes aria-hidden /> },
  { id: "tokens", label: "Tokens", icon: <Palette aria-hidden /> },
  { id: "type", label: "Type", icon: <Type aria-hidden /> },
  { id: "money", label: "Money", icon: <Banknote aria-hidden /> },
  { id: "buttons", label: "Buttons", icon: <MousePointerClick aria-hidden /> },
  { id: "fields", label: "Fields", icon: <TextCursorInput aria-hidden /> },
  { id: "badges", label: "Badges", icon: <Tag aria-hidden /> },
  { id: "stat-cards", label: "Stat cards", icon: <LayoutGrid aria-hidden /> },
  { id: "data-table", label: "Data table", icon: <TableIcon aria-hidden /> },
  { id: "proposal-card", label: "Proposal card", icon: <ClipboardCheck aria-hidden /> },
  { id: "chat-thread", label: "Chat thread", icon: <MessagesSquare aria-hidden /> },
  { id: "paystub", label: "Paystub", icon: <Receipt aria-hidden /> },
  { id: "states", label: "States", icon: <CircleDashed aria-hidden /> },
  { id: "toasts", label: "Toasts", icon: <Bell aria-hidden /> },
  { id: "sheet", label: "Sheet", icon: <PanelLeft aria-hidden /> },
  { id: "carrier-menu", label: "Carrier menu", icon: <Building2 aria-hidden /> },
  { id: "source-records", label: "Source records", icon: <Link2 aria-hidden /> },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

// One section, shown in both modes: side by side at laptop width (one above the other when `wide`,
// so tables and the thread get the width they have on a real page); under laptop width, only the
// column that matches the page's own mode (the carrier menu switches it).
function ModePair({
  id,
  note,
  wide = false,
  children,
}: {
  id: SectionId;
  note?: ReactNode;
  wide?: boolean;
  children: (mode: Mode) => ReactNode;
}) {
  const title = SECTIONS.find((s) => s.id === id)?.label ?? id;
  const column = "min-w-0 rounded-lg border border-border p-4 sm:p-6";
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="grid scroll-mt-20 gap-4 border-t border-border pt-8">
      <div className="grid max-w-[72ch] gap-1">
        <h2 id={`${id}-title`} className="text-h2 text-foreground">
          {title}
        </h2>
        {note ? <p className="text-body text-foreground-2">{note}</p> : null}
      </div>
      <div className={`grid gap-4 ${wide ? "" : "lg:grid-cols-2"}`}>
        <div data-theme="light" className={`${column} max-lg:page-dark:hidden`}>
          <p className="mb-4 text-caption text-muted-foreground">Light</p>
          {children("light")}
        </div>
        <div data-theme="dark" className={`${column} max-lg:hidden max-lg:page-dark:block`}>
          <p className="mb-4 text-caption text-muted-foreground">Dark</p>
          {children("dark")}
        </div>
      </div>
    </section>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return <p className="text-caption text-muted-foreground">{children}</p>;
}

// [token, measured against, what it is for, the floor it must clear]
const SWATCHES: [string, string, string, number | null][] = [
  ["background", "foreground", "The page", 4.5],
  ["card", "foreground", "Cards, tables, menus", 4.5],
  ["secondary", "foreground-2", "Quiet fills", 4.5],
  ["foreground", "background", "Text", 4.5],
  ["foreground-2", "card", "Second text", 4.5],
  ["muted-foreground", "card", "Hints and captions", 4.5],
  ["border", "card", "Dividers (decoration)", null],
  ["input", "card", "Field borders", 3],
  ["primary", "primary-foreground", "The accent, primary buttons", 4.5],
  ["primary-hover", "primary-foreground", "Primary on hover", 4.5],
  ["link", "card", "Links", 4.5],
  ["success", "success-soft", "Paid, confirmed", 4.5],
  ["warning", "warning-soft", "Needs a look", 4.5],
  ["destructive", "destructive-soft", "Failed, negative money", 4.5],
  ["info", "info-soft", "In progress", 4.5],
  ["ring", "background", "Focus ring", 3],
];

function Tokens({ tokens }: { tokens: TokenSet }) {
  return (
    <ul className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {SWATCHES.map(([name, against, use, floor]) => {
        const hex = tokens[name];
        const pair = tokens[against];
        const ratio = isHex(hex) && isHex(pair) ? contrastRatio(hex, pair) : null;
        const passes = ratio !== null && (floor === null || ratio >= floor);
        return (
          <li key={name} className="flex items-center gap-3">
            <span
              aria-hidden
              className="size-9 shrink-0 rounded-md border border-border"
              style={{ backgroundColor: `var(--${name})` }}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-body font-medium text-foreground">{name}</p>
              <p className="text-small text-muted-foreground">{use}</p>
            </div>
            <div className="text-right text-small tabular-nums">
              <p className="font-mono text-foreground-2">{hex ?? "missing"}</p>
              <p className={passes ? "text-foreground-2" : "text-destructive"}>
                {ratio === null ? "Not measured" : `${ratio.toFixed(2)}:1`}
                {floor !== null ? <span className="sr-only">{passes ? ", passes" : ", fails"}</span> : null}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const SCALE: [string, string, string][] = [
  ["text-figure", "Figure", "28 on 32, weight 600"],
  ["text-h1", "Heading 1", "24 on 32, weight 600"],
  ["text-h2", "Heading 2", "20 on 28, weight 600"],
  ["text-h3", "Heading 3", "16 on 24, weight 600"],
  ["text-lead", "Lead", "16 on 24"],
  ["text-body", "Body", "14 on 20"],
  ["text-small", "Small", "13 on 18"],
  ["text-caption", "Caption", "12 on 16, weight 500"],
];

// Typographic test strings, not money: equal-width figures make these three rows line up exactly.
const TABULAR_TEST = ["$1,111,111.11", "$0,000,000.00", "$8,888,888.88"];

const MONEY_SAMPLES: [string, number, "auto" | "always"][] = [
  ["Earned", 240_000, "auto"],
  ["Deducted", -20_000, "auto"],
  ["Nothing", 0, "auto"],
  ["Nine digits", 123_456_789, "auto"],
  ["A change, signed", 240_000, "always"],
];

const BUTTON_VARIANTS = ["primary", "secondary", "outline", "ghost", "destructive", "link"] as const;

export default function DesignPage() {
  const tokens = parseTokens(readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8"));
  const tokenSet = { light: tokens.light, dark: tokens.dark };

  return (
    <AppShell
      tenant={SAMPLE_TENANT}
      title="Design review"
      homeHref="/design"
      nav={SECTIONS.map((s) => ({ href: `#${s.id}`, label: s.label, icon: s.icon }))}
      signOut={
        <Button variant="ghost" disabled className="w-full justify-start">
          Sign out
        </Button>
      }
    >
      <div className="grid gap-10">
        <PageHeader
          title="Every piece, in both modes"
          description="The parts the app is built from, with invented sample data. Nothing here reads a carrier's records."
        />

        <ModePair id="identity" note="Sign green on paper, a road-line mark and one structural signature: the ledger rule under money.">
          {() => (
            <div className="grid gap-6">
              <div className="flex items-end gap-5">
                {[16, 24, 48].map((size) => (
                  <div key={size} className="grid justify-items-center gap-2">
                    <Mark size={size} label={`Payday Copilot mark at ${size} pixels`} />
                    <Caption>{size} px</Caption>
                  </div>
                ))}
              </div>
              <div className="grid gap-3">
                <Wordmark size="lg" />
                <Wordmark size="sm" />
              </div>
              <p className="max-w-[60ch] text-body text-foreground-2">
                The accent is highway guide-sign green: the color every driver reads all day, and
                the color that means go. It marks approve, paid and confirmed, and nothing else
                competes with it.
              </p>
            </div>
          )}
        </ModePair>

        <ModePair id="tokens" note="Measured at build time from the stylesheet, against the background each color is used on.">
          {(mode) => <Tokens tokens={tokenSet[mode]} />}
        </ModePair>

        <ModePair id="type" note="Public Sans, self-hosted, with tabular figures. Sentence case everywhere.">
          {() => (
            <div className="grid gap-6">
              <ul className="grid gap-3">
                {SCALE.map(([cls, name, spec]) => (
                  <li key={cls} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                    <span className={`${cls} text-foreground`}>{name}</span>
                    <Caption>{spec}</Caption>
                  </li>
                ))}
              </ul>
              <p className="max-w-[72ch] text-body text-foreground">
                A driver&apos;s paystub lists every load, every deduction and the net, and each line
                links to the record it came from. Body text runs at most 72 characters a line.
              </p>
              <div className="grid gap-1">
                <Caption>Tabular figures: the three rows line up to the pixel.</Caption>
                <div className="w-fit rounded-md border border-border bg-card px-4 py-2 text-right text-h2 tabular-nums text-foreground">
                  {TABULAR_TEST.map((t) => (
                    <p key={t}>{t}</p>
                  ))}
                </div>
              </div>
            </div>
          )}
        </ModePair>

        <ModePair id="money" note="Integer cents, two decimals, a true minus sign. The sign is the signal; the color is the echo.">
          {() => (
            <dl className="grid gap-2">
              {MONEY_SAMPLES.map(([label, cents, sign]) => (
                <div key={label} className="flex items-baseline justify-between gap-4 border-b border-border pb-2 last:border-b-0">
                  <dt className="text-body text-foreground-2">{label}</dt>
                  <dd className="text-h3">
                    <Money cents={cents} sign={sign} />
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </ModePair>

        <ModePair id="buttons" note="Every variant at rest, hovered, focused, disabled and busy. A busy button keeps its words.">
          {() => (
            <div className="grid gap-4">
              {BUTTON_VARIANTS.map((variant) => (
                <div key={variant} className="grid gap-2">
                  <Caption>{variant[0].toUpperCase() + variant.slice(1)}</Caption>
                  <div className={`flex flex-wrap items-center ${variant === "link" ? "gap-x-5 gap-y-2" : "gap-2"}`}>
                    <Button variant={variant}>Default</Button>
                    <Button variant={variant} data-demo="hover">
                      Hover
                    </Button>
                    <Button variant={variant} data-demo="focus">
                      Focus
                    </Button>
                    <Button variant={variant} disabled>
                      Disabled
                    </Button>
                    <Button variant={variant} pending pendingLabel="Saving">
                      Save
                    </Button>
                  </div>
                </div>
              ))}
              <div className="grid gap-2">
                <Caption>Sizes</Caption>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm">Small</Button>
                  <Button size="md">Medium</Button>
                  <Button size="lg">Large</Button>
                  <Button size="icon" variant="outline" aria-label="Add a note">
                    <ClipboardCheck aria-hidden />
                  </Button>
                </div>
              </div>
            </div>
          )}
        </ModePair>

        <ModePair id="fields" note="A label above every control. An error replaces the hint and names the fix.">
          {(mode) => (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={`${mode}-f-empty`} label="Driver code" hint="Like SF-D07">
                {(c) => <Input {...c} placeholder="SF-D07" />}
              </Field>
              <Field id={`${mode}-f-filled`} label="Email">
                {(c) => <Input {...c} type="email" defaultValue="ops@samplefreight.example" />}
              </Field>
              <Field id={`${mode}-f-error`} label="Advance amount" error="Enter an amount up to $500.00">
                {(c) => <Input {...c} inputMode="decimal" defaultValue="650.00" />}
              </Field>
              <Field id={`${mode}-f-disabled`} label="Time zone" hint="Set when the carrier is created">
                {(c) => <Input {...c} defaultValue={SAMPLE_TENANT.timezone} disabled />}
              </Field>
              <Field id={`${mode}-f-note`} label="Note for the driver" className="sm:col-span-2">
                {(c) => <Textarea {...c} defaultValue="Approved against the three loads delivered this week." />}
              </Field>
            </div>
          )}
        </ModePair>

        <ModePair id="badges" note="Every status the app shows, in words. The tone echoes the word, never replaces it.">
          {() => (
            <div className="flex flex-wrap gap-2">
              {BADGE_STATUSES.map((s) => (
                <StatusBadge key={s} status={s} />
              ))}
            </div>
          )}
        </ModePair>

        <ModePair id="stat-cards" note="One label, one figure, one line that links to the records behind it.">
          {() => (
            <div className="grid gap-3 sm:grid-cols-2">
              <StatCard label="Friday's pay run" value={<Money cents={1_842_000} />} hint="12 drivers, paid Oct 30" href="#paystub" />
              <StatCard label="Past 60 days" value={<Money cents={624_000} />} hint="3 invoices, oldest 74 days" tone="warning" href="#data-table" />
              <StatCard label="Advances out" value={<Money cents={115_000} />} hint="4 drivers" href="#proposal-card" />
              <StatCard label="Need a look" value="2" hint="Exceptions before Friday" tone="destructive" href="#paystub" />
            </div>
          )}
        </ModePair>

        <ModePair id="data-table" wide note="Ready, loading, empty and failed. A failed read never shows as empty.">
          {(mode) => {
            const columns = loadColumns(anchorFor(`${mode}-`));
            const base = { columns, rows: LOADS, rowKey: (r: (typeof LOADS)[number]) => r.id, pinFirstColumn: true };
            return (
              <div className="grid gap-6">
                <DataTable {...base} caption="Ready: this week's loads for Dana Whitfield" />
                <DataTable {...base} caption="Loading" state="loading" />
                <DataTable
                  {...base}
                  caption="Empty"
                  state="empty"
                  empty={{ title: "No loads this week", body: "Loads show here as dispatch books them." }}
                />
                <DataTable {...base} caption="Failed read" state="error" error={{ category: "unreadable" }} />
              </div>
            );
          }}
        </ModePair>

        <ModePair id="proposal-card" note="What the copilot wants to do, what it costs and why. A person approves; the copilot never moves money.">
          {(mode) => <ProposalGallery prefix={`${mode}-`} />}
        </ModePair>

        <ModePair id="chat-thread" wide note="The home. Steps stream in plain English; the newest one is read aloud.">
          {(mode) => <ChatDemo prefix={`${mode}-`} />}
        </ModePair>

        <ModePair id="paystub" note="The money rail: a single rule over each subtotal, the bookkeeper's double rule under the net.">
          {(mode) => <Paystub {...PAYSTUB} hrefFor={anchorFor(`${mode}-`)} />}
        </ModePair>

        <ModePair id="states" note="Every empty, loading and error state says what happened and what to do next.">
          {() => (
            <div className="grid gap-4">
              <div className="rounded-lg border border-border bg-card">
                <EmptyState
                  title="No advances this week"
                  body="When a driver asks for one, the copilot writes it up here for you to approve."
                  action={<Button variant="outline">Ask about advances</Button>}
                />
              </div>
              <div className="rounded-lg border border-border bg-card px-4 py-3">
                <LoadingState label="Reading this week's loads" rows={3} />
              </div>
              {ERROR_CATEGORIES.map((c) => (
                <div key={c} className="rounded-lg border border-border bg-card">
                  <ErrorState category={c} className="py-6" />
                </div>
              ))}
            </div>
          )}
        </ModePair>

        <ModePair id="toasts" note="News that answers an action. The buttons fire each tone in the corner of the screen.">
          {(mode) => (
            <div className="grid gap-6">
              {mode === "light" ? <ToastDemo /> : <Caption>The buttons are in the light column.</Caption>}
              <ToastsAtRest />
            </div>
          )}
        </ModePair>

        <ModePair id="sheet" note="The phone navigation, opened at any width.">
          {(mode) => (mode === "light" ? <SheetDemo /> : <Caption>The sheet opens over the whole page in its mode.</Caption>)}
        </ModePair>

        <ModePair id="carrier-menu" note="The chip in the top bar opens this. One login belongs to one carrier today.">
          {() => (
            <TenantPanel
              tenant={SAMPLE_TENANT}
              className="shadow-float"
              signOut={
                <Button variant="ghost" disabled className="w-full justify-start">
                  Sign out
                </Button>
              }
            />
          )}
        </ModePair>

        <ModePair id="source-records" wide note="Every link above lands on its row here, as it will on the record pages.">
          {(mode) => (
            <DataTable
              caption="Records the samples point at"
              rows={SOURCE_ROWS}
              rowKey={(r) => `${r.ref.table}:${r.ref.id}`}
              rowId={(r) => `${mode}-source-${r.ref.table}-${r.ref.id}`}
              columns={[
                { key: "record", header: "Record", cell: (r) => <span className="font-medium whitespace-nowrap">{recordLabel(r.ref)}</span> },
                { key: "kind", header: "Kind", cell: (r) => <span className="whitespace-nowrap">{sourceLabel(r.ref.table)}</span> },
                { key: "what", header: "What it is", wrap: true, cell: (r) => <span className="text-foreground-2">{r.what}</span> },
              ]}
            />
          )}
        </ModePair>

      </div>
    </AppShell>
  );
}
