import { PageHeader } from "@/components/app/page-header";
import { Card, CardBody } from "@/components/ui/card";
import { InlineAlert } from "@/components/ui/inline-alert";
import { flags } from "@/config/flags";
import { readDriverOptions, readShell, type DriverOption, type Shell } from "@/lib/advances/read";
import { advancesOn } from "@/lib/advances/switches";
import { withRequestTenant } from "@/lib/tenant/context";
import { AdvanceFrame, AdvancesOffPage, problemOf, ReadFailed, type ReadProblem } from "../frame";
import { RequestForm } from "./request-form";

export const dynamic = "force-dynamic";

// The request desk: pick a driver, an amount and a reason. The agent checks the pay rules and
// puts a proposal in the chat; nothing is paid until a person approves it there.
export default async function NewAdvancePage() {
  if (!advancesOn()) return <AdvancesOffPage title="New advance request" />;
  let page: { shell: Shell; drivers: DriverOption[] } | null = null;
  let problem: ReadProblem | null = null;
  try {
    page = await withRequestTenant(async (q, session) => ({
      shell: await readShell(q, session),
      drivers: await readDriverOptions(q),
    }));
  } catch (err) {
    problem = problemOf(err);
  }
  if (!page) return <ReadFailed problem={problem ?? "unreadable"} />;

  const offReason = !flags.agentEnabled
    ? "The agent is switched off, so requests cannot be checked right now."
    : !flags.aiEnabled
      ? "The models are switched off, so the agent cannot check a request right now."
      : null;
  return (
    <AdvanceFrame shell={page.shell} title="New advance request">
      <PageHeader
        title="New advance request"
        description="The agent checks the request against the pay rules and proposes an amount in the chat. Nothing is paid until a person approves it."
      />
      {offReason ? <InlineAlert tone="warning">{offReason}</InlineAlert> : null}
      <Card className="max-w-[560px]">
        <CardBody>
          <RequestForm drivers={page.drivers} disabled={offReason !== null} />
        </CardBody>
      </Card>
    </AdvanceFrame>
  );
}
