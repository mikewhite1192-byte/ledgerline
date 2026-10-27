import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { flags } from "@/config/flags";
import { findPortalLoads, type PortalLoadLine } from "@/lib/portal/read";
import { PORTAL_COOKIE } from "@/lib/portal/runner/driver";
import { withPortalTenant } from "@/lib/portal/tenant";

// Search by the broker's reference or the carrier's own load number. Without a live session the
// page reads nothing and says so.
export const dynamic = "force-dynamic";

export default async function PortalLoads({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!flags.portalRunnerEnabled) notFound();
  const sp = await searchParams;
  const query = typeof sp.q === "string" ? sp.q.slice(0, 40) : "";
  const cookie = (await cookies()).get(PORTAL_COOKIE)?.value;
  let lines: PortalLoadLine[] | null;
  try {
    lines = await withPortalTenant(cookie, new Date(), (q) => (query ? findPortalLoads(q, query) : Promise.resolve([])));
  } catch (err) {
    console.error("portal search failed:", err instanceof Error ? err.name : "unknown");
    lines = null;
  }
  if (lines === null) {
    return (
      <section>
        <h1 className="mb-4 text-3xl font-bold">No load found</h1>
        <p>Your session has ended. Use a new sign-in link.</p>
      </section>
    );
  }
  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-3xl font-bold">Find a load</h1>
        <a href="/portal/sign-out" className="underline">Sign out</a>
      </div>
      <form method="get" action="/portal/loads" className="mb-6 flex gap-3">
        <label className="flex-1">
          <span className="font-bold">Reference or load number</span>
          <input name="q" defaultValue={query} autoComplete="off" placeholder="FFE-000000" className="mt-1 block w-full border-2 border-[#333333] bg-white px-3 py-3 text-xl" />
        </label>
        <button type="submit" className="self-end border-2 border-[#2f4f3a] bg-[#2f4f3a] px-8 py-3 text-xl font-bold text-white">Search</button>
      </form>
      {query && lines.length === 0 && <p className="text-xl font-bold">No load found</p>}
      {lines.length > 0 && (
        <table className="w-full border-collapse bg-white text-left">
          <thead>
            <tr className="border-b-2 border-[#333333]">
              <th className="p-3">Reference</th>
              <th className="p-3">Load number</th>
              <th className="p-3">Consignee</th>
              <th className="p-3">Destination</th>
              <th className="p-3">POD</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.reference} className="border-b border-[#999999]">
                <td className="p-3"><Link href={`/portal/loads/${l.reference}`} className="font-bold underline">{l.reference}</Link></td>
                <td className="p-3">{l.loadNumber}</td>
                <td className="p-3">{l.consignee}</td>
                <td className="p-3">{l.destination}</td>
                <td className="p-3">{l.podStatus === "available" ? "Available" : "Pending"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
