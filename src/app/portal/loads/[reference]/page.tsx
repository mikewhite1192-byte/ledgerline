import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { flags } from "@/config/flags";
import { portalLoadByReference, type PortalLoadDetail } from "@/lib/portal/read";
import { PORTAL_COOKIE } from "@/lib/portal/runner/driver";
import { withPortalTenant } from "@/lib/portal/tenant";

// One load as the broker records it. Large type and labels beside values: the page is read from
// a 1280 x 800 screenshot. A miss of any kind (no session, other tenant, unknown reference) is
// the same "No load found".
export const dynamic = "force-dynamic";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex border-b border-[#999999] py-3">
      <dt className="w-64 font-bold">{label}</dt>
      <dd className="flex-1">{value}</dd>
    </div>
  );
}

export default async function PortalLoad({ params }: { params: Promise<{ reference: string }> }) {
  if (!flags.portalRunnerEnabled) notFound();
  const { reference } = await params;
  const cookie = (await cookies()).get(PORTAL_COOKIE)?.value;
  let load: PortalLoadDetail | null;
  try {
    load = await withPortalTenant(cookie, new Date(), (q) => portalLoadByReference(q, reference));
  } catch (err) {
    console.error("portal load read failed:", err instanceof Error ? err.name : "unknown");
    load = null;
  }
  if (!load) {
    return (
      <section>
        <h1 className="mb-4 text-3xl font-bold">No load found</h1>
        <Link href="/portal/loads" className="underline">Back to search</Link>
      </section>
    );
  }
  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-3xl font-bold">Load {load.reference}</h1>
        <Link href="/portal/loads" className="underline">Back to search</Link>
      </div>
      <dl className="bg-white px-4">
        <Row label="Carrier load number" value={load.loadNumber} />
        <Row label="Shipper" value={load.shipper} />
        <Row label="Consignee" value={`${load.consignee}, ${load.destination}`} />
        <Row label="Scheduled delivery" value={load.scheduledWindow} />
        <Row label="Delivery check-in" value={load.checkedIn ?? "Not recorded"} />
        <Row label="Delivery check-out" value={load.checkedOut ?? "Not recorded"} />
        <Row label="POD status" value={load.podStatus === "available" ? `Available, signed by ${load.podSignedBy ?? "consignee"}` : "Pending"} />
      </dl>
      <h2 className="mt-6 text-xl font-bold">Notes</h2>
      <p className="min-h-16 whitespace-pre-wrap border-2 border-[#999999] bg-white p-3">{load.notes ?? "None"}</p>
      {load.podStatus === "available" && (
        <p className="mt-6">
          <a href={`/portal/loads/${load.reference}/pod`} className="inline-block border-2 border-[#2f4f3a] bg-white px-6 py-3 text-xl font-bold text-[#2f4f3a]">
            Download POD (PDF)
          </a>
        </p>
      )}
    </section>
  );
}
