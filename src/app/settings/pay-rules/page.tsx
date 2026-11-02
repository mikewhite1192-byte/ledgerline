import Link from "next/link";
import { Scale } from "lucide-react";
import { proposalCardFrom } from "@/components/agent/proposal-card-from";
import { DataTable } from "@/components/app/data-table";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { EmptyState, ErrorState } from "@/components/app/states";
import { RuleChangeCards, type RuleChangeCard } from "@/components/pay-rules/rule-change-cards";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { InlineAlert } from "@/components/ui/inline-alert";
import { flags } from "@/config/flags";
import { readWaitingRuleChangeViews } from "@/lib/agent/gateway/store";
import { RULES_LINK_LABEL, RULES_LINK_LEAD } from "@/app/settings/autopilot/words";
import { DbError } from "@/lib/db";
import { formatLocalDate } from "@/lib/format/dates";
import { readPayRulesPage, type PayRulesPage, type PayRulesVersion } from "@/lib/pay-rules/read";
import { RULE_KEYS, RULES, formatValue, labelFor, valueOf } from "@/lib/pay-rules/rules";
import {
  CHIP_LABEL,
  CURRENT_BADGE,
  IN_FORCE_TITLE,
  LOAD_FAILED_BODY,
  LOAD_FAILED_TITLE,
  NEVER_RAN,
  PAGE_SUBTITLE,
  PAGE_TITLE,
  SET_BY,
  STARTING_RULES,
  SWITCHED_OFF,
  VERSIONS_TITLE,
  WAITING_EMPTY_BODY,
  WAITING_EMPTY_TITLE,
  WAITING_TITLE,
} from "@/lib/pay-rules/words";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { readShell, type ShellTenant } from "@/lib/tenant/shell";

export const dynamic = "force-dynamic";

type View = {
  shell: ShellTenant;
  // Null when the rules could not be read whole: the page shows its error state.
  rules: PayRulesPage | null;
  // Null with the switch off: nothing waiting is read or offered.
  cards: RuleChangeCard[] | null;
};

const SET_BY_TONE: Readonly<Record<string, BadgeTone>> = { seed: "neutral", ui: "info", proposal: "success" };

// The Pay rules page: every version of the carrier's pay rules by the first week it runs, the
// rules a sentence can change as they stand this week in plain words, and the pay rule changes
// waiting to be saved. Read in the request's tenant transaction. With the switch off the rules are
// still listed, nothing waiting is read, and the page says how to turn changes on. Signed out:
// withRequestTenant redirects.
export default async function PayRulesSettings() {
  let view: View | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    view = await withRequestTenant(async (q, session): Promise<View> => {
      const shell = await readShell(q, session);
      const now = new Date();
      let rules: PayRulesPage | null = null;
      try {
        rules = await readPayRulesPage(q, session.sub, now);
      } catch (err) {
        // A failed statement ends the transaction: let the page's own error state take it.
        if (err instanceof DbError) throw err;
        console.warn(`pay rules page: the rules could not be read (${err instanceof Error ? err.name : "unknown"})`);
        return { shell, rules: null, cards: null };
      }
      if (!flags.rulesByTalkingEnabled) return { shell, rules, cards: null };
      const audit = { on: flags.auditorEnabled, checking: false };
      const viewer = { admin: rules.role === "admin", adminAboveCents: flags.approverRole.adminAboveCents };
      const cards = (await readWaitingRuleChangeViews(q)).map((p) => ({
        card: proposalCardFrom(p, audit, viewer),
        verdict: p.auditorVerdict,
        flagged: p.flagged,
      }));
      return { shell, rules, cards };
    });
  } catch (err) {
    if (err instanceof ForbiddenError) problem = "forbidden";
    else if (err instanceof DbError) problem = "unreadable";
    else throw err;
  }
  if (!view) return <NoCarrierPage problem={problem ?? "unreadable"} />;
  const { rules, cards } = view;
  // The button opens the chat with an example change, so it shows only while the chat can take
  // one: pay rule changes, the agent and the models all on. Otherwise it is left out.
  const chatTakesChanges = flags.rulesByTalkingEnabled && flags.agentEnabled && flags.aiEnabled;

  return (
    <SignedInPage tenant={view.shell} current="/settings/pay-rules" title={PAGE_TITLE}>
      <PageHeader
        title={PAGE_TITLE}
        description={PAGE_SUBTITLE}
        actions={
          chatTakesChanges && rules ? (
            <Link href="/?rule=1" className={buttonVariants({ variant: "primary" })}>
              {CHIP_LABEL}
            </Link>
          ) : undefined
        }
      />
      {!flags.rulesByTalkingEnabled ? <InlineAlert tone="neutral">{SWITCHED_OFF}</InlineAlert> : null}
      {flags.autopilotRules.enabled ? (
        <p className="text-small text-foreground-2">
          {RULES_LINK_LEAD}
          <Link href="/settings/autopilot" className="underline underline-offset-4">
            {RULES_LINK_LABEL}
          </Link>
          .
        </p>
      ) : null}
      {rules ? (
        <>
          <Versions rules={rules} />
          <InForce rules={rules} />
          {cards ? <Waiting cards={cards} /> : null}
        </>
      ) : (
        <Card>
          <ErrorState category="unreadable" title={LOAD_FAILED_TITLE} body={LOAD_FAILED_BODY} />
        </Card>
      )}
    </SignedInPage>
  );
}

function Versions({ rules }: { rules: PayRulesPage }) {
  const first = rules.versions[0]?.id;
  return (
    <DataTable<PayRulesVersion>
      caption={VERSIONS_TITLE}
      rows={rules.versions}
      rowKey={(v) => v.id}
      columns={[
        {
          key: "starts",
          header: "Starts",
          cell: (v) => (
            <span className="inline-flex items-center gap-2">
              {v.firstWeek ? formatLocalDate(v.firstWeek) : NEVER_RAN}
              {v.id === rules.currentId ? <Badge tone="success">{CURRENT_BADGE}</Badge> : null}
            </span>
          ),
        },
        {
          key: "changed",
          header: "What changed",
          wrap: true,
          cell: (v) => (v.id === first ? STARTING_RULES : (v.note ?? "")),
        },
        {
          key: "set-by",
          header: "Set by",
          cell: (v) => <Badge tone={SET_BY_TONE[v.source] ?? "neutral"}>{SET_BY[v.source] ?? SET_BY.ui}</Badge>,
        },
        {
          key: "weeks",
          header: "Weeks paid under it",
          align: "right",
          cell: (v) => v.weeksPaid.toLocaleString("en-US"),
        },
      ]}
    />
  );
}

function InForce({ rules }: { rules: PayRulesPage }) {
  const current = rules.versions.find((v) => v.id === rules.currentId);
  if (!current) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{IN_FORCE_TITLE}</CardTitle>
      </CardHeader>
      <CardBody>
        <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {RULE_KEYS.map((key) => {
            const spec = RULES[key];
            return (
              <div key={key} className="grid gap-0.5">
                <dt className="text-small text-foreground-2" title={spec.help}>
                  {labelFor(key, current.insurance_applies_to)}
                </dt>
                <dd className="text-body font-medium text-foreground tabular-nums">
                  {formatValue(spec, valueOf(current, key))}
                </dd>
                <dd className="text-caption text-muted-foreground">{spec.help}</dd>
              </div>
            );
          })}
        </dl>
      </CardBody>
    </Card>
  );
}

function Waiting({ cards }: { cards: RuleChangeCard[] }) {
  return (
    <section aria-labelledby="waiting-title" className="grid gap-3">
      <h3 id="waiting-title" className="text-h3 text-foreground">
        {WAITING_TITLE}
      </h3>
      {cards.length > 0 ? (
        <RuleChangeCards cards={cards} auditorOn={flags.auditorEnabled} />
      ) : (
        <EmptyState icon={<Scale aria-hidden />} title={WAITING_EMPTY_TITLE} body={WAITING_EMPTY_BODY} />
      )}
    </section>
  );
}
