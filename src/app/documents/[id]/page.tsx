import Link from "next/link";
import { flags } from "@/config/flags";
import { appNav } from "@/components/app/app-nav";
import { AppShell } from "@/components/app/app-shell";
import { DataTable, type Column } from "@/components/app/data-table";
import { PageHeader } from "@/components/app/page-header";
import { ErrorState, FeatureOff } from "@/components/app/states";
import {
  claimRows,
  fieldLabel,
  fieldStatusBadge,
  fieldValue,
  kindLabel,
  matchedLabel,
  noneSentence,
  noteSentence,
  readStatusBadge,
  type ClaimRow,
} from "@/components/documents/labels";
import { ReadAgainButton } from "@/components/documents/read-again";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InlineAlert } from "@/components/ui/inline-alert";
import { getDocument } from "@/lib/documents/service";
import { READ_ATTEMPTS_MAX, type DocumentView, type FieldCheck, type MatchFound } from "@/lib/documents/types";
import { formatInstant } from "@/lib/format/dates";
import { isUuid } from "@/lib/uuid";
import { NoCarrier, problemOf, readCarrier, SignOut } from "../carrier";

// One document: the file on the left (on a phone, first), and on the right what Muse Spark read
// next to what the records say. Every value from the document is a claim; nothing here writes.
export const dynamic = "force-dynamic";

const compareColumns: Column<FieldCheck>[] = [
  { key: "field", header: "Field", cell: (f) => fieldLabel(f.name) },
  { key: "claim", header: "Document says", wrap: true, cell: (f) => fieldValue(f.name, f.claim) },
  { key: "record", header: "Record says", wrap: true, cell: (f) => fieldValue(f.name, f.record) },
  {
    key: "status",
    header: "Check",
    cell: (f) => {
      const badge = fieldStatusBadge(f.status);
      return <Badge tone={badge.tone}>{badge.label}</Badge>;
    },
  },
];

const claimColumns: Column<ClaimRow>[] = [
  { key: "field", header: "Field", cell: (c) => fieldLabel(c.name) },
  { key: "claim", header: "Document says", wrap: true, cell: (c) => c.value },
  {
    key: "confidence",
    header: "Check",
    cell: (c) =>
      c.low ? <Badge tone="warning">Low confidence</Badge> : <Badge tone="neutral">Not compared</Badge>,
  },
];

function Preview({ view }: { view: DocumentView }) {
  const src = `/api/documents/${view.id}/file`;
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>The file</CardTitle>
        <CardDescription>
          {view.filename}
          {view.mime === "application/pdf" ? `, ${view.pageCount} ${view.pageCount === 1 ? "page" : "pages"}` : ""}
        </CardDescription>
      </CardHeader>
      <CardBody>
        {view.mime === "application/pdf" ? (
          <iframe src={src} title={`${view.filename}, the uploaded PDF`} className="h-[70dvh] w-full rounded-md border border-border bg-card" />
        ) : (
          // The file route answers with no-store for one carrier's login; the image optimizer would
          // cache private bytes, so the plain element is used on purpose.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={`${view.filename}, the uploaded photo`} className="h-auto w-full rounded-md border border-border" />
        )}
      </CardBody>
    </Card>
  );
}

function Comparison({ view, match }: { view: DocumentView; match: MatchFound }) {
  const notes = match.notes.map((n) => noteSentence(n, view.kind)).filter((s): s is string => s !== null);
  return (
    <div className="grid gap-4">
      <DataTable
        caption={`What the document says next to ${matchedLabel(view) ?? "the record"}`}
        columns={compareColumns}
        rows={match.fields}
        rowKey={(f) => f.name}
        pinFirstColumn
        empty={{ title: "No fields to compare." }}
      />
      {notes.length > 0 ? (
        <InlineAlert tone="neutral" title="Checked by LedgerLine">
          <ul className="grid list-disc gap-1 pl-5">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </InlineAlert>
      ) : null}
      {match.supports === "load_rate_fill" ? (
        <InlineAlert tone="info" title="The agent can propose filling this load's rate">
          The rate confirmation agrees with the load and its arithmetic adds up. Ask the agent; a person approves
          before the rate is saved.
        </InlineAlert>
      ) : match.supports === "missing_reimbursement" ? (
        <InlineAlert tone="info" title="The agent can propose the missing reimbursement">
          Ask the agent; a person approves before the driver&apos;s pay changes.
        </InlineAlert>
      ) : null}
    </div>
  );
}

function ReadResult({ view }: { view: DocumentView }) {
  if (view.readStatus === "budget") {
    return (
      <Card>
        <ErrorState
          category="budget"
          title="Demo budget reached"
          body="This document was stored but not read. A person can read it by eye."
        />
      </Card>
    );
  }
  if (view.readStatus === "unreadable") {
    return (
      <Card>
        <ErrorState
          category="unreadable"
          title="Could not read this document"
          body="Try a sharper photo or a PDF."
        />
      </Card>
    );
  }
  if (view.readStatus === "pending") {
    if (!view.stalled) {
      return (
        <InlineAlert tone="info" title="Still reading">
          Muse Spark is reading this document, or its last try could not finish. Reload the page in a minute or
          two to see where it stands.
        </InlineAlert>
      );
    }
    return view.readAttempts >= READ_ATTEMPTS_MAX ? (
      <Card>
        <CardHeader>
          <CardTitle>Read did not finish</CardTitle>
          <CardDescription>
            This document was tried {READ_ATTEMPTS_MAX} times. Upload a clearer copy.
          </CardDescription>
        </CardHeader>
      </Card>
    ) : (
      <Card>
        <CardHeader>
          <CardTitle>Read did not finish</CardTitle>
          <CardDescription>The last read stopped before it saved anything.</CardDescription>
        </CardHeader>
        <CardBody>
          <ReadAgainButton documentId={view.id} />
        </CardBody>
      </Card>
    );
  }
  if (!view.read) {
    return (
      <Card>
        <ErrorState category="unreadable" title="Could not show this reading" body="Try again in a moment." />
      </Card>
    );
  }
  const match = view.match;
  return (
    <div className="grid gap-4">
      {view.read.fields.sampleWord ? (
        <InlineAlert tone="neutral">This document is marked as a sample.</InlineAlert>
      ) : null}
      {match && match.found ? (
        <Comparison view={view} match={match} />
      ) : (
        <>
          <InlineAlert tone="neutral" title="Not matched to a record">
            {match ? noneSentence(match.reason, view.kind) : "The comparison with your records could not be made."}
          </InlineAlert>
          <DataTable
            caption="What the document says"
            columns={claimColumns}
            rows={claimRows(view.read)}
            rowKey={(c) => c.key}
            empty={{ title: "No fields were read from this document." }}
          />
        </>
      )}
      {view.inputId ? (
        <div>
          <Link href={`/?document=${view.inputId}`} className={buttonVariants({ variant: "primary" })}>
            Ask the agent about this document
          </Link>
        </div>
      ) : null}
    </div>
  );
}

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { carrier, problem } = await readCarrier();
  if (!carrier) return <NoCarrier problem={problem} />;
  const { id } = await params;

  let view: DocumentView | null = null;
  let readProblem: "forbidden" | "unreadable" | null = null;
  if (flags.documentsEnabled && isUuid(id)) {
    try {
      view = await getDocument(carrier.session, id);
    } catch (err) {
      readProblem = problemOf(err);
    }
  }

  const back = (
    <Link href="/documents" className={buttonVariants({ variant: "outline" })}>
      All documents
    </Link>
  );

  let body;
  if (!flags.documentsEnabled) {
    body = (
      <Card>
        <FeatureOff name="Documents" plural />
      </Card>
    );
  } else if (readProblem) {
    body = (
      <Card>
        <ErrorState
          category={readProblem}
          retry={
            <Link
              href={`/documents/${id}`}
              prefetch={false}
              className="text-small font-medium text-primary underline-offset-2 hover:underline"
            >
              Try again
            </Link>
          }
        />
      </Card>
    );
  } else if (!view) {
    body = (
      <Card>
        <ErrorState category="not_found" />
      </Card>
    );
  } else {
    const badge = readStatusBadge(view);
    body = (
      <>
        <div className="flex flex-wrap items-center gap-2 text-small text-foreground-2">
          <Badge tone={badge.tone}>{badge.label}</Badge>
          <span>Uploaded {formatInstant(view.createdAt, carrier.timezone)}</span>
        </div>
        <div className="grid min-w-0 gap-6 md:grid-cols-2 md:items-start">
          <div className="min-w-0">
            <Preview view={view} />
          </div>
          <div className="grid min-w-0 gap-4">
            <ReadResult view={view} />
            {view.readStatus === "read" || view.readCallId !== null ? (
              <p className="text-caption text-muted-foreground">
                Read by Muse Spark 1.3. Trace <span className="font-mono break-all">{view.traceId}</span>
              </p>
            ) : null}
          </div>
        </div>
      </>
    );
  }

  return (
    <AppShell
      tenant={{ name: carrier.name, email: carrier.email, timezone: carrier.timezone }}
      nav={appNav("/documents")}
      title="Documents"
      signOut={<SignOut />}
    >
      <div className="mx-auto grid w-full max-w-[1080px] gap-6">
        <PageHeader
          title={view ? kindLabel(view.kind) : "Document"}
          description="What Muse Spark read, next to what your records say. Values from the document are claims."
          actions={back}
        />
        {body}
      </div>
    </AppShell>
  );
}
