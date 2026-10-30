import { Badge, type BadgeTone } from "@/components/ui/badge";
import { requestStatusWords } from "@/lib/factoring/words";

// A factoring request's or invoice line's status in words, with its tone as the echo.
const TONES: Readonly<Record<string, BadgeTone>> = {
  submitted: "info",
  unknown: "warning",
  funded: "success",
  partly_funded: "warning",
  declined: "destructive",
  failed: "destructive",
};

export function RequestStatus({ status }: { status: string }) {
  return <Badge tone={Object.hasOwn(TONES, status) ? TONES[status] : "neutral"}>{requestStatusWords(status)}</Badge>;
}

// The Test mode mark every factoring screen carries: no real money moves.
export function TestModeBadge() {
  return <Badge tone="info">Test mode</Badge>;
}
