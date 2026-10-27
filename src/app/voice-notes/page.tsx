import Link from "next/link";
import { DataTable } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InlineAlert } from "@/components/ui/inline-alert";
import { flags } from "@/config/flags";
import { readDriverOptions, readShell, type DriverOption, type Shell } from "@/lib/advances/read";
import { formatInstant } from "@/lib/format/dates";
import { withRequestTenant } from "@/lib/tenant/context";
import { voiceOn } from "@/lib/voice/http";
import { readVoiceList, type VoiceListRow } from "@/lib/voice/read";
import { categoryLabel, languageLabel } from "@/lib/voice/words";
import { problemOf, ReadFailed, type ReadProblem } from "../advances/frame";
import { VoiceFrame, VoiceOffPage, VoiceStatusBadge } from "./frame";
import { Uploader } from "./uploader";

export const dynamic = "force-dynamic";

// Drivers' voice notes, newest first, and the way to add one. A note is transcribed, screened, put
// in English and sorted; a person hands it to the agent from its page. Dark while the voice switch
// is off.
const DESCRIPTION =
  "A driver's voice note, in English or Spanish, transcribed and screened before any model reads it. The agent proposes; a person approves every payout.";

export default async function VoiceNotesPage() {
  if (!voiceOn()) return <VoiceOffPage title="Voice notes" description={DESCRIPTION} />;
  let page: { shell: Shell; drivers: DriverOption[]; rows: VoiceListRow[] } | null = null;
  let problem: ReadProblem | null = null;
  try {
    page = await withRequestTenant(async (q, session) => ({
      shell: await readShell(q, session),
      drivers: await readDriverOptions(q),
      rows: await readVoiceList(q, null),
    }));
  } catch (err) {
    problem = problemOf(err);
  }
  if (!page) return <ReadFailed problem={problem ?? "unreadable"} />;

  const zone = page.shell.timezone;
  const offReason = !flags.aiEnabled ? "The models are switched off, so new notes cannot be read right now." : null;
  return (
    <VoiceFrame shell={page.shell} title="Voice notes">
      <PageHeader title="Voice notes" description={DESCRIPTION} />
      <Card>
        <CardHeader>
          <CardTitle>Add a voice note</CardTitle>
          <CardDescription>Record one here or pick a clip. The sample clips in this demo are synthetic voices.</CardDescription>
        </CardHeader>
        <CardBody className="grid gap-4">
          {offReason ? <InlineAlert tone="warning">{offReason}</InlineAlert> : null}
          <Uploader
            drivers={page.drivers}
            disabled={offReason !== null}
            agentOn={flags.agentEnabled === true}
            limits={{
              maxWavBytes: flags.voiceLimits.maxWavBytes,
              maxOriginalBytes: flags.voiceLimits.maxOriginalBytes,
              maxDurationMs: flags.voiceLimits.maxDurationMs,
            }}
          />
        </CardBody>
      </Card>
      <DataTable<VoiceListRow>
        caption="Voice notes"
        rows={page.rows}
        rowKey={(r) => r.id}
        empty={{
          title: "No voice notes yet",
          body: "Add one above. The sample clips are in /samples, like voice-es-advance.wav.",
        }}
        columns={[
          {
            key: "received",
            header: "Received",
            cell: (r) => (
              <Link href={`/voice-notes/${r.id}`} className="font-medium whitespace-nowrap text-link underline-offset-4 hover:underline">
                {formatInstant(r.createdAt, zone)}
              </Link>
            ),
          },
          {
            key: "driver",
            header: "Driver",
            cell: (r) =>
              r.driverCode ? (
                <span className="whitespace-nowrap">
                  {r.driverName}
                  <span className="block text-small text-muted-foreground">{r.driverCode}</span>
                </span>
              ) : (
                <span className="text-muted-foreground">Not matched</span>
              ),
          },
          { key: "language", header: "Language", cell: (r) => languageLabel(r.language) },
          { key: "category", header: "Sorted as", cell: (r) => categoryLabel(r.category) },
          {
            key: "amount",
            header: "Amount heard",
            align: "right",
            cell: (r) => (r.amountCents === null ? <span className="text-muted-foreground">None</span> : <Money cents={r.amountCents} />),
          },
          { key: "status", header: "Status", cell: (r) => <VoiceStatusBadge status={r.status} /> },
        ]}
      />
    </VoiceFrame>
  );
}
