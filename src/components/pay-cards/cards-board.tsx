"use client";

import { Download, ImageIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useToast } from "@/components/app/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import type { CardCategory } from "@/lib/pay-cards/read";
import type { CardSpec } from "@/lib/pay-cards/spec";
import {
  CARD_ERROR_FALLBACK,
  CARD_ERROR_WORDS,
  CARD_PILL_TONES,
  CARD_PILL_WORDS,
  CARD_REASON_WORDS,
  type CardPill,
} from "@/lib/pay-cards/words";
import { blobBase64, cardPng, CardPreview } from "./card-canvas";

export type BoardRow = {
  settlementId: string;
  driverName: string;
  spec: CardSpec;
  pill: CardPill;
  reason: CardCategory | null;
  checkedId: string | null;
  attemptsUsed: number;
};

const MAX_ATTEMPTS = 3;

// Refusals that stop the whole run: every later card would meet the same answer.
const STOPS_RUN: ReadonlySet<string> = new Set([
  "cards_off",
  "ai_off",
  "budget",
  "batch_cap",
  "day_cap",
  "forbidden",
  "unauthenticated",
]);

// A row that can still get a card: not checked for its current figures, a try left, and not being
// checked right now.
const needsCard = (r: BoardRow) => r.pill !== "checked" && r.pill !== "checking" && r.attemptsUsed < MAX_ATTEMPTS;

function errorOf(json: unknown): string {
  return json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string"
    ? (json as { error: string }).error
    : "unknown";
}

type Outcome = { pill: CardPill; reason: CardCategory | null; checkedId: string | null; used: boolean };

function outcomeOf(json: Record<string, unknown>): Outcome | null {
  const status = json.status;
  const category = typeof json.category === "string" ? (json.category as CardCategory) : null;
  const cardId = typeof json.cardId === "string" ? json.cardId : null;
  if (status === "checked" && cardId) return { pill: "checked", reason: null, checkedId: cardId, used: true };
  if (status === "mismatch") return { pill: "mismatch", reason: category, checkedId: null, used: true };
  if (status === "unavailable") {
    return { pill: category === "budget" ? "budget" : "unavailable", reason: category, checkedId: null, used: true };
  }
  return null;
}

export function CardsBoard({
  rows: initial,
  offReason,
  maxPngBytes,
}: {
  rows: BoardRow[];
  offReason?: string;
  maxPngBytes: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const [rows, setRows] = useState(initial);
  // Fresh rows from the server (after a refresh) replace what this page last showed.
  const [shown, setShown] = useState(initial);
  if (shown !== initial) {
    setShown(initial);
    setRows(initial);
  }
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const todo = rows.filter(needsCard);

  function update(id: string, change: Partial<BoardRow>) {
    setRows((now) => now.map((r) => (r.settlementId === id ? { ...r, ...change } : r)));
  }

  async function make() {
    const list = rows.filter(needsCard);
    if (list.length === 0) return;
    setRunning(true);
    // One run of this page: the server holds its spend under the run's own cap.
    const traceId = crypto.randomUUID();
    try {
      for (let i = 0; i < list.length; i++) {
        const row = list[i];
        setProgress(`Checking card ${i + 1} of ${list.length}`);
        update(row.settlementId, { pill: "checking", reason: null });
        let res: Response;
        let json: Record<string, unknown> = {};
        try {
          const image = await blobBase64(await cardPng(row.spec, maxPngBytes));
          res = await fetch("/api/pay-cards", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ settlementId: row.settlementId, traceId, image }),
          });
          try {
            const parsed: unknown = await res.json();
            if (parsed && typeof parsed === "object") json = parsed as Record<string, unknown>;
          } catch {
            json = {};
          }
        } catch {
          update(row.settlementId, { pill: row.pill, reason: row.reason });
          toast({ title: "The card was not checked", body: CARD_ERROR_FALLBACK, tone: "warning" });
          return;
        }
        const outcome = res.ok ? outcomeOf(json) : null;
        if (outcome) {
          update(row.settlementId, {
            pill: outcome.pill,
            reason: outcome.reason,
            checkedId: outcome.checkedId,
            attemptsUsed: Math.min(MAX_ATTEMPTS, row.attemptsUsed + 1),
          });
          continue;
        }
        const code = res.ok ? "unknown" : errorOf(json);
        update(row.settlementId, { pill: code === "budget" ? "budget" : row.pill, reason: row.reason });
        if (STOPS_RUN.has(code)) {
          toast({ title: "Pay cards stopped", body: CARD_ERROR_WORDS[code] ?? CARD_ERROR_FALLBACK, tone: "warning" });
          return;
        }
        if (code !== "already_checked") {
          toast({ title: `${row.driverName}: card not saved`, body: CARD_ERROR_WORDS[code] ?? CARD_ERROR_FALLBACK, tone: "warning" });
        }
      }
    } finally {
      setRunning(false);
      setProgress(null);
      router.refresh();
    }
  }

  const label = todo.length === 0 ? "Make pay cards" : `Make ${todo.length} pay ${todo.length === 1 ? "card" : "cards"}`;
  const checked = rows.filter((r) => r.pill === "checked").length;

  return (
    <div className="grid gap-4">
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid min-w-0 gap-0.5">
            <p className="text-body font-medium text-foreground">
              {checked} of {rows.length} {rows.length === 1 ? "card" : "cards"} checked
            </p>
            <p className="text-small text-foreground-2" aria-live="polite">
              {offReason ??
                progress ??
                (todo.length === 0
                  ? "Every card that can be made is made."
                  : "Each card is checked against the paystub before it can be saved. Nothing is sent.")}
            </p>
          </div>
          <Button onClick={make} disabled={todo.length === 0 || offReason !== undefined} pending={running} pendingLabel={progress ?? "Checking"}>
            <ImageIcon aria-hidden />
            {label}
          </Button>
        </CardBody>
      </Card>
      <ul className="grid gap-3" aria-label="Pay cards">
        {rows.map((r) => (
          <li key={r.settlementId}>
            <Card>
              <CardBody className="flex items-start gap-4">
                <CardPreview spec={r.spec} label={`Pay card for ${r.spec.firstName}, ${r.spec.text.net}`} />
                <div className="grid min-w-0 flex-1 gap-1.5">
                  <p className="truncate text-body font-medium text-foreground">{r.driverName}</p>
                  <p className="text-small text-foreground-2">Take-home pay {r.spec.text.net}</p>
                  <div>
                    <Badge tone={CARD_PILL_TONES[r.pill]}>{CARD_PILL_WORDS[r.pill]}</Badge>
                  </div>
                  {r.reason && r.pill !== "checked" ? (
                    <p className="text-small text-foreground-2">{CARD_REASON_WORDS[r.reason] ?? CARD_ERROR_FALLBACK}</p>
                  ) : null}
                  {r.pill !== "checked" && r.attemptsUsed >= MAX_ATTEMPTS ? (
                    <p className="text-small text-foreground-2">All three tries are used for this paystub.</p>
                  ) : null}
                  {r.pill === "checked" && r.checkedId ? (
                    <a
                      href={`/api/pay-cards/${r.checkedId}/file`}
                      download
                      className="inline-flex w-fit items-center gap-1.5 text-small text-link underline-offset-4 hover:underline"
                    >
                      <Download aria-hidden className="size-4" />
                      Save image
                    </a>
                  ) : null}
                </div>
              </CardBody>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
