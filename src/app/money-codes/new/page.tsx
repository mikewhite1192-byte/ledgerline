import Link from "next/link";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage } from "@/components/app/signed-in-page";
import { Card, CardBody } from "@/components/ui/card";
import { flags } from "@/config/flags";
import { formatCents } from "@/lib/format/money";
import { readRequestChoices, type RequestChoices } from "@/lib/money-codes/request";
import { moneyCodesOn } from "@/lib/money-codes/switches";
import { TEST_MODE_NOTE } from "@/lib/money-codes/words";
import { withRequestTenant } from "@/lib/tenant/context";
import { readShell, type ShellTenant } from "@/lib/tenant/shell";
import { CodesFrame, CodesOffPage, codesProblemOf, CodesTitle, type CodesProblem } from "../frame";
import { CodeRequestForm } from "./request-form";

export const dynamic = "force-dynamic";

// Request a code: a load on the road or delivered in the last three days (its driver comes with
// it), the amount, the purpose and, optionally, a receipt already read. The pay rules check it at
// once; a passing request waits as a card on the Money codes page. Nothing is issued until a
// person approves it there.
export default async function NewMoneyCodePage() {
  if (!moneyCodesOn()) return <CodesOffPage title="Request a code" />;
  let page: { shell: ShellTenant; choices: RequestChoices } | null = null;
  let problem: CodesProblem | null = null;
  try {
    page = await withRequestTenant(async (q, session) => ({
      shell: await readShell(q, session),
      choices: await readRequestChoices(q, new Date()),
    }));
  } catch (err) {
    problem = codesProblemOf(err);
  }
  if (!page) return <NoCarrierPage problem={problem ?? "unreadable"} />;
  const capCents = flags.moneyCodes.capCents;
  return (
    <CodesFrame shell={page.shell} title="Request a code">
      <PageHeader
        title={<CodesTitle>Request a code</CodesTitle>}
        description="Your pay rules check the request now. It then waits on the Money codes page until someone approves it; nothing is issued before that."
      />
      <p>
        <Link href="/money-codes" className="text-small text-link underline-offset-4 hover:underline">
          All money codes
        </Link>
      </p>
      <Card className="max-w-[560px]">
        <CardBody>
          <CodeRequestForm
            loads={page.choices.loads}
            receipts={page.choices.receipts}
            capCents={Number.isSafeInteger(capCents) && capCents > 0 ? capCents : null}
            capWords={Number.isSafeInteger(capCents) && capCents > 0 ? formatCents(capCents) : null}
          />
        </CardBody>
      </Card>
      <p className="text-small text-foreground-2">{TEST_MODE_NOTE}</p>
    </CodesFrame>
  );
}
