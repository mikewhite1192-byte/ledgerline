import { DbError } from "@/lib/db";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";

type Carrier = {
  name: string;
  timezone: string;
  email: string;
  counts: { drivers: number; loads: number; periods: number };
};

// The signed-in carrier's shell. Every read runs inside withRequestTenant, so this page can only
// ever see the carrier on the verified token. Signed out: withRequestTenant redirects to /sign-in.
export default async function Home() {
  let carrier: Carrier | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    carrier = await withRequestTenant(async (q, session) => {
      const tenants = await q.query<{ name: string; timezone: string }>(
        "SELECT name, timezone FROM tenants WHERE id = current_tenant_id()",
      );
      const members = await q.query<{ email: string }>(
        "SELECT email FROM memberships WHERE cognito_sub = $1",
        [session.sub],
      );
      if (tenants.length !== 1 || members.length !== 1) throw new ForbiddenError();
      // Each count names its tenant, as every read does.
      const [counts] = await q.query<{ drivers: number; loads: number; periods: number }>(
        `SELECT (SELECT count(*) FROM drivers WHERE tenant_id = current_tenant_id()) AS drivers,
                (SELECT count(*) FROM loads WHERE tenant_id = current_tenant_id()) AS loads,
                (SELECT count(*) FROM settlement_periods WHERE tenant_id = current_tenant_id())
                  AS periods`,
      );
      if (!counts) throw new DbError("unknown");
      return {
        name: tenants[0].name,
        timezone: tenants[0].timezone,
        email: members[0].email,
        counts,
      };
    });
  } catch (err) {
    // Anything else (the redirect to /sign-in among them) goes on to Next.
    if (err instanceof ForbiddenError) problem = "forbidden";
    else if (err instanceof DbError) problem = "unreadable";
    else throw err;
  }

  return (
    <main style={{ maxWidth: 640, margin: "64px auto", padding: "0 16px" }}>
      <h1>LedgerLine</h1>
      {carrier ? (
        <>
          <h2 style={{ marginTop: 24 }}>{carrier.name}</h2>
          <p style={{ marginTop: 8 }}>Time zone: {carrier.timezone}</p>
          <p style={{ marginTop: 8 }}>Signed in as {carrier.email}</p>
          <p style={{ marginTop: 8 }}>
            {carrier.counts.drivers} drivers, {carrier.counts.loads} loads,{" "}
            {carrier.counts.periods} pay periods
          </p>
          <p style={{ marginTop: 24 }}>
            Drivers, loads and this week&apos;s pay run arrive with the next items.
          </p>
        </>
      ) : problem === "forbidden" ? (
        <p role="alert" style={{ marginTop: 24 }}>
          This login is not linked to a carrier.
        </p>
      ) : (
        // Unknown is not empty: a failed or timed-out read never shows as "no data".
        <p role="alert" style={{ marginTop: 24 }}>
          Could not read your carrier&apos;s data. Try again in a moment.
        </p>
      )}
      <form action="/api/auth/sign-out" method="post" style={{ marginTop: 24 }}>
        <button type="submit" style={{ padding: "8px 10px", font: "inherit" }}>
          Sign out
        </button>
      </form>
    </main>
  );
}
