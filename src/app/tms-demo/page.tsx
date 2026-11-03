import Link from "next/link";
import { notFound } from "next/navigation";
import { ErrorState } from "@/components/app/states";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { flags } from "@/config/flags";
import { DbError } from "@/lib/db";
import { formatInstant } from "@/lib/format/dates";
import { readBoard, type BoardRow } from "@/lib/mock-tms/store";
import { demoCarrierOf } from "@/lib/seed/reset";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";

export const dynamic = "force-dynamic";

type View = { kind: "ready"; zone: string; rows: BoardRow[] } | { kind: "off_mock" };

// MOCK-TMS: the sample dispatch system's board, the demo carrier's loads newest first. Signed out:
// withRequestTenant redirects. A carrier that is not a demo carrier has no board here.
export default async function TmsDemoBoard() {
  if (flags.mockTms.enabled !== true) notFound();
  let view: View | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    view = await withRequestTenant<View | null>(async (q) => {
      if (!(await demoCarrierOf(q))) return null;
      const board = await readBoard(q);
      return board === null ? { kind: "off_mock" } : { kind: "ready", zone: board.zone, rows: board.rows };
    });
  } catch (err) {
    if (err instanceof ForbiddenError) problem = "forbidden";
    else if (err instanceof DbError) problem = "unreadable";
    else throw err;
  }
  if (problem === null && view === null) notFound();

  return (
    <Card>
      <CardHeader>
        <div className="grid gap-0.5">
          <CardTitle>Loads</CardTitle>
          <CardDescription>Open a load to assign a driver, complete a stop or set its status.</CardDescription>
        </div>
        {flags.mockTms.newLoad === true && view?.kind === "ready" ? (
          <Link href="/tms-demo/loads/new" className={buttonVariants({ variant: "secondary" })}>
            New load
          </Link>
        ) : null}
      </CardHeader>
      <CardBody>
        {problem ? (
          <ErrorState category={problem} />
        ) : view?.kind === "off_mock" ? (
          <p className="text-body text-foreground-2">
            This carrier still reads the built-in demo feed. A demo reset puts it on the sample dispatch system.
          </p>
        ) : view?.kind === "ready" ? (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>Load</Th>
                  <Th>Status</Th>
                  <Th>Customer</Th>
                  <Th>Driver</Th>
                  <Th>Truck</Th>
                  <Th>Lane</Th>
                  <Th>Updated</Th>
                </Tr>
              </THead>
              <TBody>
                {view.rows.map((r) => (
                  <Tr key={r.reference}>
                    <Td>
                      <Link href={`/tms-demo/loads/${encodeURIComponent(r.reference)}`} className="underline">
                        {r.reference}
                      </Link>
                    </Td>
                    <Td>{r.statusLabel}</Td>
                    <Td>{r.customerName ?? "None"}</Td>
                    <Td>{r.driverExternalId ?? "None"}</Td>
                    <Td>{r.truckUnit ?? "None"}</Td>
                    <Td>{r.lane}</Td>
                    <Td>{formatInstant(r.updatedAt, view.zone)}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
