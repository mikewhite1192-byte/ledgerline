// The Inbox's shapes: one row per message a driver sent the carrier (inbound_messages, migration
// 0037), as the pipeline and the routes see it. The message text lives in untrusted_inputs.

export const INBOUND_STATUSES = ["received", "blocked", "triaged", "handed_off", "failed"] as const;
export type InboundStatus = (typeof INBOUND_STATUSES)[number];

export type InboundChannel = "paste" | "email";

// The row as a list shows it: no message text.
export type InboundMessage = {
  id: string;
  channel: InboundChannel;
  status: InboundStatus;
  failCategory: string | null;
  attempts: number;
  receivedAt: string;
  fromAddress: string | null;
  subject: string | null;
  // The driver the sender's address matched, and that driver's code and name. Never a driver a
  // model named.
  driverId: string | null;
  driverCode: string | null;
  driverName: string | null;
  category: string | null;
  urgency: string | null;
  amountCents: number | null;
  dates: string[];
  triageTarget: "spark" | "spark_open" | null;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InboundTraceRow = {
  target: string;
  purpose: string;
  status: string;
  durationMs: number | null;
  costNanocents: number;
};

// One message for its own page: the text (a person must be able to read a held one), the trace
// id and the model calls made for it.
export type InboundDetail = InboundMessage & {
  text: string | null;
  traceId: string;
  trace: InboundTraceRow[];
};

// What arrives: a paste from the page (its id made by the page, so a repeated press is the same
// row) or, later, an email (its id made by the mail route; messageId is its Message-ID header).
export type ReceiveInput = {
  id: string;
  channel: InboundChannel;
  text: string;
  fromAddress: string | null;
  subject: string | null;
  receivedAt: Date;
  messageId: string | null;
};
