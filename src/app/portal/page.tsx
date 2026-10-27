import { notFound } from "next/navigation";
import { flags } from "@/config/flags";
import { isUuid } from "@/lib/uuid";

// Sign-in: a carrier number and a one-time access code (design 3.2). The tenant travels in the
// link a person or a run is given, so the code is checked inside that tenant only.
export const dynamic = "force-dynamic";

const field = "mt-1 block w-full border-2 border-[#333333] bg-white px-3 py-3 text-xl";

export default async function PortalSignIn({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!flags.portalRunnerEnabled) notFound();
  const sp = await searchParams;
  const t = typeof sp.t === "string" && isUuid(sp.t) ? sp.t : "";
  const failed = sp.e === "1";
  return (
    <section className="max-w-md">
      <h1 className="mb-4 text-3xl font-bold">Sign in</h1>
      {!t && <p className="mb-4 border-2 border-[#8a2b2b] bg-white p-3">Use the sign-in link you were given.</p>}
      {failed && (
        <p role="alert" className="mb-4 border-2 border-[#8a2b2b] bg-white p-3">
          Sign-in failed. Check the carrier number and access code.
        </p>
      )}
      <form method="post" action="/portal/sign-in" className="space-y-5">
        <input type="hidden" name="t" value={t} />
        <label className="block">
          <span className="font-bold">Carrier number</span>
          <input name="carrierNumber" autoComplete="off" placeholder="MC-000000" className={field} required />
        </label>
        <label className="block">
          <span className="font-bold">Access code</span>
          <input name="code" autoComplete="off" className={field} required />
        </label>
        <button type="submit" className="border-2 border-[#2f4f3a] bg-[#2f4f3a] px-8 py-3 text-xl font-bold text-white">
          Sign in
        </button>
      </form>
    </section>
  );
}
