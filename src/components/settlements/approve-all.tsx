"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Money } from "@/components/app/money";
import { postJson } from "@/components/invoices/post-json";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { formatCents } from "@/lib/format/money";
import { settlementOutcome } from "@/lib/settlements/labels";

export type CleanRow = { proposalId: string; settlementId: string; driverCode: string; driverName: string; netCents: number };

type Counts = { sent: number; confirmed: number; failed: number; unknown: number; remaining: number };

// Between drain calls while a batch is still sending, and the most calls one confirm makes before
// it leaves the rest to the batch page's "Continue".
const POLL_MS = 1_500;
const MAX_DRAINS = 20;

const whole = (v: unknown): number => (Number.isSafeInteger(v) ? (v as number) : 0);

function countsOf(data: Record<string, unknown>): Counts {
  return {
    sent: whole(data.sent),
    confirmed: whole(data.confirmed),
    failed: whole(data.failed),
    unknown: whole(data.unknown),
    remaining: whole(data.remaining),
  };
}

const progress = (c: Counts) =>
  `${c.confirmed} confirmed, ${c.failed} failed, ${c.unknown} not confirmed yet, ${c.remaining} still to send.`;

// "Approve all clean (n, $total)": a confirm sheet listing every paystub and the total, sent as
// exactly that list. A list that changed underneath comes back as the list as it stands now, to
// confirm again. After the confirm, the page drains the batch (each call sends what fits in one
// request) until nothing is left to send, showing the counts.
export function ApproveAll({ periodId, items, totalCents }: { periodId: string; items: CleanRow[]; totalCents: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState({ items, totalCents });
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState("");
  const [batchId, setBatchId] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) setList({ items, totalCents });
  }, [items, totalCents, open]);

  async function drain(id: string) {
    for (let i = 0; i < MAX_DRAINS && alive.current; i += 1) {
      const reply = await postJson(`/api/batches/${encodeURIComponent(id)}/drain`);
      if (!alive.current) return;
      if (!reply.ok) {
        setNote(settlementOutcome(reply.error));
        return;
      }
      const counts = countsOf(reply.data);
      setNote(progress(counts));
      if (reply.data.status !== "draining") return;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  async function confirm() {
    if (pending || list.items.length === 0) return;
    setPending(true);
    setNote("");
    const reply = await postJson("/api/batches", {
      periodId,
      proposalIds: list.items.map((i) => i.proposalId),
      totalCents: list.totalCents,
    });
    if (reply.ok && typeof reply.data.batchId === "string") {
      const id = reply.data.batchId;
      setBatchId(id);
      setOpen(false);
      if (reply.data.status === "done") setNote(settlementOutcome("not_paid"));
      else await drain(id);
    } else if (reply.error === "stale") {
      const current = reply.data.current as { items?: CleanRow[]; totalCents?: number } | undefined;
      setList({ items: Array.isArray(current?.items) ? current.items : [], totalCents: whole(current?.totalCents) });
      setNote("The clean list changed since you opened it. Check it again before you approve.");
    } else {
      setNote(settlementOutcome(reply.error));
    }
    if (alive.current) setPending(false);
    router.refresh();
  }

  // The batch approval: its count, total and every line never hide.
  return (
    <div className="flex flex-wrap items-center gap-3" data-amounts="shown">
      <Button type="button" variant="primary" onClick={() => setOpen(true)} disabled={items.length === 0}>
        Approve all clean ({items.length}, {formatCents(totalCents)})
      </Button>
      <p role="status" className="text-small text-foreground-2">
        {note}
        {batchId ? (
          <>
            {" "}
            <Link href={`/batches/${encodeURIComponent(batchId)}`} className="text-link underline-offset-4 hover:underline">
              See the batch
            </Link>
          </>
        ) : null}
      </p>
      <Sheet open={open} onClose={() => setOpen(false)} label="Approve all clean" className="w-[min(28rem,calc(100vw-2rem))]">
        <div className="grid gap-4 overflow-y-auto p-5 pt-12">
          <h2 className="text-h2 text-foreground">Approve {list.items.length} paystubs</h2>
          <p className="text-small text-foreground-2">
            Each one is clean: no exceptions, nothing flagged, and the second check agreed. Approving pays each driver
            the net shown.
          </p>
          {list.items.length === 0 ? (
            <p className="text-body text-foreground">Nothing is clean right now.</p>
          ) : (
            <ul className="grid gap-1.5">
              {list.items.map((i) => (
                <li key={i.proposalId} className="flex items-baseline justify-between gap-3 text-body">
                  <span className="min-w-0 truncate">
                    {i.driverName} <span className="text-foreground-2">{i.driverCode}</span>
                  </span>
                  <Money cents={i.netCents} tone="plain" />
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-baseline justify-between border-t border-border pt-3 text-body font-semibold">
            <span>Total</span>
            <Money cents={list.totalCents} tone="plain" />
          </div>
          <Button
            type="button"
            variant="primary"
            pending={pending}
            disabled={list.items.length === 0}
            onClick={() => void confirm()}
          >
            Approve {list.items.length} for {formatCents(list.totalCents)}
          </Button>
          <p role="status" className="text-small text-foreground-2">
            {note}
          </p>
        </div>
      </Sheet>
    </div>
  );
}
