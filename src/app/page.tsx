import { flags } from "@/config/flags";
import {
  capNanocents,
  centsToDisplay,
  dollarsToDisplay,
  wonderCapNanocents,
} from "@/lib/ai/prices";
import { readRecentCalls, readSpend, type CallRow, type Spend } from "@/lib/ai/spend";
import { DbError } from "@/lib/db";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { AiProofForm } from "./ai-proof-form";

type ModelLedger = { calls: CallRow[]; spend: Spend };
type Carrier = { name: string; timezone: string; email: string; ledger: ModelLedger | null };

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
      // The model check's read-back, from the database on every render: this carrier's newest
      // calls (row-level security applies) and the global spend counter.
      const ledger = flags.aiProofRoute
        ? { calls: await readRecentCalls(q, 5), spend: await readSpend(q) }
        : null;
      return {
        name: tenants[0].name,
        timezone: tenants[0].timezone,
        email: members[0].email,
        ledger,
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
      <h1>Payday Copilot</h1>
      {carrier ? (
        <>
          <h2 style={{ marginTop: 24 }}>{carrier.name}</h2>
          <p style={{ marginTop: 8 }}>Time zone: {carrier.timezone}</p>
          <p style={{ marginTop: 8 }}>Signed in as {carrier.email}</p>
          <p style={{ marginTop: 24 }}>
            Drivers, loads and this week&apos;s pay run arrive with the next items.
          </p>
          {carrier.ledger ? <ModelCheck ledger={carrier.ledger} /> : null}
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

function ModelCheck({ ledger }: { ledger: ModelLedger }) {
  const cap = capNanocents(process.env.AI_SPEND_CAP_CENTS);
  const wonderCap = wonderCapNanocents(process.env.AI_WONDER_CAP_CENTS, cap);
  const { spend } = ledger;
  return (
    <section style={{ marginTop: 32 }}>
      <h2>Model connection</h2>
      <AiProofForm />
      <p style={{ marginTop: 12 }}>
        Spent so far {dollarsToDisplay(spend.spentNanocents)} of{" "}
        {cap === null ? "no cap (every call is refused)" : dollarsToDisplay(cap)}
        {spend.reservedNanocents > 0
          ? `, plus ${dollarsToDisplay(spend.reservedNanocents)} held for calls in flight or with no answer`
          : ""}
        . Calls: {spend.calls}. Wonder: {dollarsToDisplay(spend.wonderSpentNanocents)} of{" "}
        {wonderCap === null ? "no cap (every Wonder call is refused)" : dollarsToDisplay(wonderCap)}
        {spend.wonderReservedNanocents > 0
          ? `, plus ${dollarsToDisplay(spend.wonderReservedNanocents)} held`
          : ""}
        .
      </p>
      {ledger.calls.length > 0 ? (
        <ul style={{ marginTop: 12, paddingLeft: 18 }}>
          {ledger.calls.map((c) => (
            <li key={c.id} style={{ marginTop: 4 }}>
              {c.created_utc} UTC, {c.target} {c.kind}, {c.purpose}, {c.status}
              {c.failure ? ` (${c.failure})` : ""}
              {c.reasoning_effort ? `, ${c.reasoning_effort} effort` : ""}
              {c.input_tokens !== null
                ? `, ${c.input_tokens} in, ${c.output_tokens} out (${c.reasoning_tokens} reasoning)`
                : ""}
              {c.units !== null
                ? `, ${c.units} ${c.kind === "transcribe" ? "audio seconds" : "images"}`
                : ""}
              {c.duration_ms !== null ? `, ${c.duration_ms} ms` : ""}
              {c.cost_nanocents !== null ? `, ${centsToDisplay(c.cost_nanocents)} cents` : ""}
              {c.upstream_id ? `, ${c.upstream_id}` : ""}
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ marginTop: 12 }}>No model calls yet.</p>
      )}
    </section>
  );
}
