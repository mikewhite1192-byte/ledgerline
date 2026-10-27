import Link from "next/link";
import { flags } from "@/config/flags";
import { appNav } from "@/components/app/app-nav";
import { AppShell } from "@/components/app/app-shell";
import { DataTable, type Column } from "@/components/app/data-table";
import { Money } from "@/components/app/money";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/states";
import { kindLabel, matchedLabel, partyOf, readStatusBadge } from "@/components/documents/labels";
import { UploadForm } from "@/components/documents/upload-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { listDocuments } from "@/lib/documents/service";
import type { DocumentView } from "@/lib/documents/types";
import { formatInstant } from "@/lib/format/dates";
import { NoCarrier, problemOf, readCarrier, SignOut } from "./carrier";

// Documents: upload a receipt, a rate confirmation or a bill of lading, and see what Muse Spark
// read from each one next to what the records say. Row security limits every read to the carrier
// on the verified token. Behind flags.documentsEnabled.
export const dynamic = "force-dynamic";

const DESCRIPTION = "Receipts, rate confirmations and bills of lading, read by Muse Spark";

export default async function DocumentsPage() {
  const { carrier, problem } = await readCarrier();
  if (!carrier) return <NoCarrier problem={problem} />;

  let documents: DocumentView[] = [];
  let listProblem: "forbidden" | "unreadable" | null = null;
  if (flags.documentsEnabled) {
    try {
      documents = await listDocuments(carrier.session);
    } catch (err) {
      listProblem = problemOf(err);
    }
  }

  const columns: Column<DocumentView>[] = [
    {
      key: "document",
      header: "Document",
      wrap: true,
      cell: (d) => (
        <Link
          href={`/documents/${d.id}`}
          className="font-medium text-foreground underline-offset-2 hover:text-primary hover:underline"
        >
          {kindLabel(d.kind)}
          <span className="block text-caption font-normal text-muted-foreground">{d.filename}</span>
        </Link>
      ),
    },
    { key: "party", header: "Vendor or customer", wrap: true, cell: (d) => partyOf(d) ?? "None" },
    { key: "date", header: "Date", cell: (d) => d.read?.fields.date ?? "None" },
    {
      key: "total",
      header: "Total",
      align: "right",
      cell: (d) => {
        const cents = d.read?.fields.totalCents ?? null;
        return cents === null ? "None" : <Money cents={cents} />;
      },
    },
    { key: "match", header: "Matched record", cell: (d) => matchedLabel(d) ?? "None" },
    {
      key: "status",
      header: "Read",
      cell: (d) => {
        const badge = readStatusBadge(d);
        return <Badge tone={badge.tone}>{badge.label}</Badge>;
      },
    },
    {
      key: "uploaded",
      header: "Uploaded",
      cell: (d) => formatInstant(d.createdAt, carrier.timezone),
    },
  ];

  return (
    <AppShell
      tenant={{ name: carrier.name, email: carrier.email, timezone: carrier.timezone }}
      nav={appNav("/documents")}
      title="Documents"
      signOut={<SignOut />}
    >
      <div className="mx-auto grid w-full max-w-[1080px] gap-6">
        <PageHeader title="Documents" description={DESCRIPTION} />
        {!flags.documentsEnabled ? (
          <Card>
            <EmptyState
              title="Document reading is not switched on."
              body="When it is, upload a receipt or a rate confirmation here and Muse Spark reads it."
            />
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Upload a document</CardTitle>
                <CardDescription>
                  Muse Spark reads the document once. What it reads is a claim, shown next to what your records
                  say; nothing changes until a person approves it.
                </CardDescription>
              </CardHeader>
              <CardBody>
                <UploadForm
                  maxBytes={flags.documentLimits.maxBytes}
                  maxPdfPages={flags.documentLimits.maxPdfPages}
                />
              </CardBody>
            </Card>
            <DataTable
              caption="Your latest documents, newest first"
              columns={columns}
              rows={documents}
              rowKey={(d) => d.id}
              state={listProblem ? "error" : "ready"}
              empty={{
                title: "No documents yet.",
                body: "Drop a receipt or a rate confirmation here.",
              }}
              error={{
                category: listProblem ?? "unreadable",
                retry: (
                  <Link
                    href="/documents"
                    prefetch={false}
                    className="text-small font-medium text-primary underline-offset-2 hover:underline"
                  >
                    Try again
                  </Link>
                ),
              }}
            />
          </>
        )}
      </div>
    </AppShell>
  );
}
