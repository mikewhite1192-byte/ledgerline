import { Badge, type BadgeTone } from "@/components/ui/badge";
import { statusLabel } from "@/lib/format/labels";

// The text is the signal; the tone is the echo. An unknown status is neutral and reads in words.
const TONES: Record<string, BadgeTone> = {
  planned: "neutral",
  requested: "neutral",
  draft: "neutral",
  open: "neutral",
  reserved: "neutral",
  proposed: "neutral",
  drafting: "neutral",
  drafted: "neutral",
  in_transit: "info",
  approved: "info",
  sent: "info",
  executing: "info",
  delivered: "success",
  invoiced: "success",
  paid: "success",
  confirmed: "success",
  done: "success",
  ok: "success",
  partially_paid: "warning",
  past_due: "warning",
  unknown: "warning",
  incomplete: "warning",
  refused: "warning",
  over_cap: "warning",
  rejected: "destructive",
  failed: "destructive",
  void: "destructive",
  cancelled: "destructive",
  expired: "warning",
};

// Every status that has a tone of its own, for /design to show.
export const BADGE_STATUSES: readonly string[] = Object.keys(TONES);

export function statusTone(status: string): BadgeTone {
  return Object.hasOwn(TONES, status) ? TONES[status] : "neutral";
}

export function StatusBadge({
  status,
  label,
  className,
}: {
  status: string;
  label?: string;
  className?: string;
}) {
  return (
    <Badge tone={statusTone(status)} className={className}>
      {label ?? statusLabel(status)}
    </Badge>
  );
}
