"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineAlert } from "@/components/ui/inline-alert";
import { actionSentence, checkSentence, type CheckSummary } from "@/lib/money-codes/words";

type Body = {
  error?: unknown;
  code?: unknown;
  summary?: unknown;
  tooNew?: unknown;
  stillWaiting?: unknown;
};

async function post(url: string): Promise<{ ok: boolean; body: Body }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  let body: Body = {};
  try {
    body = (await res.json()) as Body;
  } catch {
    body = {};
  }
  return { ok: res.ok, body };
}

const errorOf = (body: Body) => actionSentence(typeof body.error === "string" ? body.error : "unavailable");
const TEN_DIGITS = /^\d{10}$/;

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

// Check pending's answer, only when the reply is the whole of it. An empty, cut-off or malformed
// body is null: unknown, so it reads as not reached, never as nothing waiting.
function checkAnswerOf(body: Body): { summary: CheckSummary; tooNew: number; stillWaiting: number } | null {
  const s = body.summary;
  if (typeof s !== "object" || s === null) return null;
  const { checked, confirmed, failed, stillUnknown } = s as Record<string, unknown>;
  if (!isCount(checked) || !isCount(confirmed) || !isCount(failed) || !isCount(stillUnknown)) return null;
  if (!isCount(body.tooNew) || !isCount(body.stillWaiting)) return null;
  return { summary: { checked, confirmed, failed, stillUnknown }, tooNew: body.tooNew, stillWaiting: body.stillWaiting };
}

// Reveal: asks the server for an issued code's digits and shows them in large type with Copy. The
// digits live only in this view's memory; they are never put in the address, the page or storage,
// and Hide clears them. Each Reveal is logged on the server with who and when.
export function CodeReveal({ codeId }: { codeId: string }) {
  const [code, setCode] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  async function reveal() {
    if (pending) return;
    setPending(true);
    setNotice(null);
    try {
      const { ok, body } = await post(`/api/money-codes/${encodeURIComponent(codeId)}/reveal`);
      if (ok && typeof body.code === "string" && TEN_DIGITS.test(body.code)) setCode(body.code);
      else setNotice({ ok: false, text: ok ? actionSentence("unavailable") : errorOf(body) });
    } catch {
      setNotice({ ok: false, text: actionSentence("unavailable") });
    } finally {
      setPending(false);
    }
  }

  async function copy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setNotice({ ok: true, text: "Copied. Read it to the driver or send it the way your office does." });
    } catch {
      setNotice({ ok: false, text: "This browser would not copy. Read the code from the screen instead." });
    }
  }

  return (
    <div className="grid gap-3">
      {code ? (
        <>
          <p className="font-mono text-[2rem] leading-tight tracking-[0.2em] text-foreground tabular-nums" aria-label={`Code ${code.split("").join(" ")}`}>
            {code.slice(0, 5)} {code.slice(5)}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => void copy()}>
              Copy code
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setCode(null);
                setNotice(null);
              }}
            >
              Hide
            </Button>
          </div>
        </>
      ) : (
        <div>
          <Button variant="primary" pending={pending} pendingLabel="Showing" disabled={pending} onClick={() => void reveal()}>
            Show code
          </Button>
        </div>
      )}
      {notice ? <InlineAlert tone={notice.ok ? "success" : "destructive"}>{notice.text}</InlineAlert> : null}
    </div>
  );
}

// Check pending: reads the code's open payment record back by its stored request id. Never asks
// for a new code; the page reads itself again after.
export function CheckPending({ codeId }: { codeId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  async function check() {
    if (pending) return;
    setPending(true);
    setNotice(null);
    try {
      const { ok, body } = await post(`/api/money-codes/${encodeURIComponent(codeId)}/check`);
      if (!ok) {
        setNotice({ ok: false, text: errorOf(body) });
      } else {
        const answer = checkAnswerOf(body);
        setNotice(
          answer
            ? { ok: true, text: checkSentence(answer.summary, answer.tooNew, answer.stillWaiting) }
            : { ok: false, text: actionSentence("unavailable") },
        );
      }
    } catch {
      setNotice({ ok: false, text: actionSentence("unavailable") });
    } finally {
      setPending(false);
      router.refresh();
    }
  }

  return (
    <div className="grid gap-3">
      <div>
        <Button variant="outline" pending={pending} pendingLabel="Checking" disabled={pending} onClick={() => void check()}>
          Check pending
        </Button>
      </div>
      {notice ? <InlineAlert tone={notice.ok ? "success" : "destructive"}>{notice.text}</InlineAlert> : null}
    </div>
  );
}
