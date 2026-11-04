import Link from "next/link";
import { notFound } from "next/navigation";
import { ErrorState } from "@/components/app/states";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { flags } from "@/config/flags";
import { DbError } from "@/lib/db";
import { formatInstant, formatLocalDate, zoneName } from "@/lib/format/dates";
import { formatCents } from "@/lib/format/money";
import { ourLoadIdOf } from "@/lib/mock-tms/new-load";
import { ourPaperStatusOf } from "@/lib/mock-tms/paperwork";
import { readMockLoad, STATUS_CHOICES, type MockLoadView } from "@/lib/mock-tms/store";
import { demoTemplateOf } from "@/lib/seed/reset";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { localClockOf } from "@/lib/tms/clocks";
import { SYNTHETIC_LABELS } from "@/lib/tms/status";
import { hookWords } from "./hook-words";
import { AssignDriverForm, CompleteStopForm, SetStatusForm } from "./load-actions";
import { DriverPaperworkCard } from "./paperwork-form";

export const dynamic = "force-dynamic";
// A driver's paperwork tap waits for one model read (src/lib/documents/service.ts budgets the
// request at 27 of the hosting server's 30 seconds, as POST /api/documents does).
export const maxDuration = 30;

const STATUS_OPTIONS = STATUS_CHOICES.map((code) => ({ value: code, label: SYNTHETIC_LABELS[code] }));

const when = (at: string | null, zone: string) => (at === null ? "Not yet" : formatInstant(at, zone));
// A local clock ("2026-11-02T08:00") as "Nov 2, 2026, 8:00 AM"; the window carries no zone.
function clockWords(local: string): string {
  const [day, time] = local.split("T");
  const [h, m] = time.split(":").map(Number);
  return `${formatLocalDate(day)}, ${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
const windowOf = (from: string | null, to: string | null) =>
  from === null || to === null ? "Not set" : `${clockWords(from)} to ${clockWords(to)}`;

// A history row's field and change in words: the driver by name, and "Set to" when there was no
// value before.
const FIELD_WORDS: Record<string, string> = {
  status: "Status",
  driver: "Driver",
  pickup_completed: "Pickup completed",
  delivery_completed: "Delivery completed",
};
function changeWords(from: string | null, to: string | null, name: (v: string) => string): string {
  if (to === null) return from === null ? "Cleared" : `Cleared (was ${name(from)})`;
  return from === null ? `Set to ${name(to)}` : `${name(from)} to ${name(to)}`;
}

function decodeRef(raw: string): string | null {
  try {
    const ref = decodeURIComponent(raw);
    return ref.length > 0 && ref.length <= 120 ? ref : null;
  } catch {
    return null;
  }
}

// MOCK-TMS: one load in the sample dispatch system, with its stops, lines, documents and history,
// and the buttons a dispatcher presses. Nothing here is LedgerLine's own record.
export default async function MockLoadPage({ params }: { params: Promise<{ ref: string }> }) {
  if (flags.mockTms.enabled !== true) notFound();
  const reference = decodeRef((await params).ref);
  if (reference === null) notFound();
  let view: MockLoadView | null = null;
  // LedgerLine's own load with this number, linked only while the new load form is on.
  let ourId: string | null = null;
  // LedgerLine's own load status, read only while the driver's phone is on.
  let ourStatus: string | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    const got = await withRequestTenant<{ read: MockLoadView | null; ours: string | null; status: string | null }>(async (q) => {
      if (!(await demoTemplateOf(q))) return { read: null, ours: null, status: null };
      const read = await readMockLoad(q, reference);
      const ours = read !== null && flags.mockTms.newLoad === true ? await ourLoadIdOf(q, reference) : null;
      const status = read !== null && flags.driverPaperwork.enabled === true ? await ourPaperStatusOf(q, reference) : null;
      return { read, ours, status };
    });
    view = got.read;
    ourId = got.ours;
    ourStatus = got.status;
  } catch (err) {
    if (err instanceof ForbiddenError) problem = "forbidden";
    else if (err instanceof DbError) problem = "unreadable";
    else throw err;
  }
  if (problem) return <ErrorState category={problem} />;
  if (view === null) notFound();

  const { load, zone } = view;
  const pickup = view.stops.find((s) => s.kind === "pickup" && s.completedAt === null);
  const delivery = view.stops.find((s) => s.kind === "delivery" && s.completedAt === null);
  const nowLocal = localClockOf(new Date().toISOString(), zone);
  const { drivers } = view;
  const nameOf = (id: string) => drivers.find((d) => d.externalId === id)?.name ?? id;
  const driverName = load.driverExternalId === null ? null : nameOf(load.driverExternalId);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap gap-4">
        <Link href="/tms-demo" className="text-body text-foreground underline">
          All loads
        </Link>
        {ourId !== null ? (
          <Link href={`/records/loads/${ourId}`} className="text-body text-foreground underline">
            Open in LedgerLine
          </Link>
        ) : null}
      </div>
      <Card>
        <CardHeader>
          <div className="grid gap-0.5">
            <CardTitle>{`Load ${load.reference}`}</CardTitle>
            <CardDescription>{`${load.statusLabel}. Times shown in ${zoneName(zone, new Date())}.`}</CardDescription>
          </div>
        </CardHeader>
        <CardBody>
          <dl className="grid gap-2 text-body sm:grid-cols-2">
            <div>
              <dt className="text-small text-foreground-2">Customer</dt>
              <dd>{load.customerName ?? "Not set"}</dd>
            </div>
            <div>
              <dt className="text-small text-foreground-2">Driver</dt>
              <dd>{driverName ?? "Not assigned"}</dd>
            </div>
            <div>
              <dt className="text-small text-foreground-2">Truck</dt>
              <dd>{load.truckUnit ?? "Not assigned"}</dd>
            </div>
            <div>
              <dt className="text-small text-foreground-2">Last change</dt>
              <dd>{formatInstant(load.updatedAt, zone)}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-small text-foreground-2">Last update sent to LedgerLine</dt>
              <dd>
                {load.lastHookAt === null || load.lastHookResult === null
                  ? "None yet"
                  : `${formatInstant(load.lastHookAt, zone)}: ${hookWords(load.lastHookResult)}`}
              </dd>
            </div>
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Dispatch</CardTitle>
        </CardHeader>
        <CardBody className="grid gap-6">
          <AssignDriverForm
            reference={load.reference}
            drivers={view.drivers.map((d) => ({ value: d.externalId, label: d.name }))}
          />
          {pickup ? (
            <CompleteStopForm reference={load.reference} kind="pickup" defaultLocal={nowLocal} />
          ) : delivery ? (
            <CompleteStopForm reference={load.reference} kind="delivery" defaultLocal={nowLocal} />
          ) : null}
          <SetStatusForm reference={load.reference} current={load.statusLabel} choices={STATUS_OPTIONS} />
        </CardBody>
      </Card>

      {flags.driverPaperwork.enabled === true && ourStatus !== null ? (
        <DriverPaperworkCard reference={load.reference} status={ourStatus} />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Stops</CardTitle>
        </CardHeader>
        <CardBody className="overflow-x-auto">
          <Table>
            <THead>
              <Tr>
                <Th>Stop</Th>
                <Th>Place</Th>
                <Th>Appointment (local)</Th>
                <Th>Arrived</Th>
                <Th>Departed</Th>
              </Tr>
            </THead>
            <TBody>
              {view.stops.map((s, i) => (
                <Tr key={i}>
                  <Td>{s.kind === "pickup" ? "Pickup" : "Delivery"}</Td>
                  <Td>{`${s.name}, ${s.city}, ${s.state}`}</Td>
                  <Td>{windowOf(s.apptFromLocal, s.apptToLocal)}</Td>
                  <Td>{when(s.arrivedAt, zone)}</Td>
                  <Td>{when(s.completedAt, zone)}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Line items</CardTitle>
        </CardHeader>
        <CardBody className="overflow-x-auto">
          <Table>
            <THead>
              <Tr>
                <Th>Type</Th>
                <Th>Description</Th>
                <Th align="right">Amount</Th>
              </Tr>
            </THead>
            <TBody>
              {view.lines.map((x, i) => (
                <Tr key={i}>
                  <Td>{x.typeLabel}</Td>
                  <Td>{x.description}</Td>
                  <Td align="right">{formatCents(x.amountCents)}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Documents</CardTitle>
        </CardHeader>
        <CardBody>
          {view.documents.length === 0 ? (
            <p className="text-body text-foreground-2">None on file.</p>
          ) : (
            <ul className="grid gap-1 text-body">
              {view.documents.map((d, i) => (
                <li key={i}>{`${d.typeLabel}: ${d.fileName}, ${formatInstant(d.updatedAt, zone)}`}</li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardBody className="overflow-x-auto">
          <Table>
            <THead>
              <Tr>
                <Th>When</Th>
                <Th>What</Th>
                <Th>Change</Th>
                <Th>By</Th>
              </Tr>
            </THead>
            <TBody>
              {view.history.map((h) => (
                <Tr key={h.seq}>
                  <Td>{formatInstant(h.at, zone)}</Td>
                  <Td>{FIELD_WORDS[h.field] ?? h.field}</Td>
                  <Td>{changeWords(h.from, h.to, h.field === "driver" ? nameOf : (v) => v)}</Td>
                  <Td>{h.by ?? "Unknown"}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </CardBody>
      </Card>
    </div>
  );
}
