import { beforeEach, describe, expect, it, vi } from "vitest";

// The inbound mail poster with every outside call faked: the S3 read, the key read and fetch.
// Nothing leaves the machine. The parse is the real mailparser on hand-written messages.
const s3Send = vi.fn();
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = s3Send;
  },
  GetObjectCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

import {
  MAX_RAW_BYTES,
  MAX_TEXT_CHARS,
  bodyText,
  handle,
  parseTenants,
  readConfig,
  tenantFor,
} from "../lambda/inbound-mail/index.mjs";

const ACME = "0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b";
const ACME2 = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const ROW = "6b1c9d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e";
const KEY = "k".repeat(48);
const DOMAIN = "inbound.example.com";
const ENV = {
  APP_URL: "https://main.example.amplifyapp.com",
  TENANTS: `acme=${ACME},acme2=${ACME2}`,
  DOMAIN,
  SECRET_ARN: "arn:aws:secretsmanager:us-east-2:000000000000:secret:example-AbCdEf",
  BUCKET: "example-raw-mail",
};
const MESSAGE_ID = "0100018cexamplemessage01";

const TEXT_MAIL = [
  "From: Pat Driver <pat@example.net>",
  `To: acme@${DOMAIN}`,
  "Subject: Lumper at the dock",
  "Message-ID: <a1@example.net>",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Need a $300 advance for diesel at the Joliet yard.",
  "",
].join("\r\n");

const HTML_MAIL = [
  "From: pat@example.net",
  `To: acme@${DOMAIN}`,
  "Subject: Detention",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<html><head><style>p{color:red}</style></head><body><p>Waited&nbsp;4 hours</p><script>x()</script><p>at the dock</p></body></html>",
  "",
].join("\r\n");

type Rec = {
  recipients?: string[];
  dmarc?: string;
  virus?: string;
  messageId?: string;
};

function record({ recipients = [`acme@${DOMAIN}`], dmarc = "PASS", virus = "PASS", messageId = MESSAGE_ID }: Rec = {}) {
  return {
    eventSource: "aws:ses",
    ses: {
      mail: { messageId, timestamp: "2026-11-02T16:00:00.000Z", source: "pat@example.net" },
      receipt: {
        recipients,
        dmarcVerdict: { status: dmarc },
        virusVerdict: { status: virus },
        spamVerdict: { status: "PASS" },
      },
    },
  };
}

function answer(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("inbound mail poster", () => {
  let logs: string[];
  let fetchMock: ReturnType<typeof vi.fn>;
  let readRaw: ReturnType<typeof vi.fn>;
  let readKey: ReturnType<typeof vi.fn>;

  // An extra value of undefined leaves that call to the real default (the S3 read, faked above).
  const run = (records: unknown[], extra: Record<string, unknown> = {}) => {
    const overrides: Record<string, unknown> = { env: ENV, readRaw, readKey, fetch: fetchMock, log: (l: string) => logs.push(l), ...extra };
    for (const k of Object.keys(overrides)) if (overrides[k] === undefined) delete overrides[k];
    return handle({ Records: records }, overrides);
  };

  beforeEach(() => {
    logs = [];
    s3Send.mockReset();
    fetchMock = vi.fn().mockResolvedValue(answer(202, { id: ROW, status: "triaged" }));
    readRaw = vi.fn().mockResolvedValue({ tooBig: false, bytes: Buffer.from(TEXT_MAIL) });
    readKey = vi.fn().mockResolvedValue(KEY);
  });

  const noSecretsInLogs = () => {
    for (const line of logs) {
      expect(line).not.toContain(KEY);
      expect(line).not.toContain("diesel");
      expect(line).not.toContain("Lumper");
      expect(line).not.toContain("pat@example.net");
    }
  };

  it("the poster maps a recipient by whole local part and never by prefix", () => {
    const tenants = parseTenants(ENV.TENANTS)!;
    expect(tenantFor(`acme@${DOMAIN}`, tenants, DOMAIN)).toBe(ACME);
    expect(tenantFor(`ACME@Inbound.Example.com`, tenants, DOMAIN)).toBe(ACME);
    expect(tenantFor(`acme2@${DOMAIN}`, tenants, DOMAIN)).toBe(ACME2);
    for (const other of [
      `ac@${DOMAIN}`,
      `acme3@${DOMAIN}`,
      `acme.x@${DOMAIN}`,
      `acme+x@${DOMAIN}`,
      `xacme@${DOMAIN}`,
      `acme@other.example.com`,
      `acme@sub.${DOMAIN}`,
      `acme@${DOMAIN}.evil.example`,
      `acme@x@${DOMAIN}`,
      `@${DOMAIN}`,
      "acme",
      "",
    ]) {
      expect(tenantFor(other, tenants, DOMAIN), other).toBeNull();
    }
    expect(tenantFor(undefined, tenants, DOMAIN)).toBeNull();
    // A hand-changed TENANTS that is not whole slug=uuid pairs is refused as a whole.
    expect(parseTenants(`acme=${ACME}x`)).toBeNull();
    expect(parseTenants(`acme=${ACME},acme=${ACME2}`)).toBeNull();
    expect(parseTenants(`acme=${ACME}=1`)).toBeNull();
    expect(parseTenants("")?.size).toBe(0);
  });

  it("skips a message over 1 MB with one log line and no post", async () => {
    readRaw.mockResolvedValueOnce({ tooBig: true, size: MAX_RAW_BYTES + 1 });
    const out = await run([record()]);
    expect(out).toEqual({ ok: true, outcomes: ["too_big"] });
    expect(readRaw).toHaveBeenCalledWith(ENV.BUCKET, `raw/${MESSAGE_ID}`);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
    expect(logs).toEqual([`inbound mail ${MESSAGE_ID} skipped: over ${MAX_RAW_BYTES} bytes (${MAX_RAW_BYTES + 1})`]);
  });

  it("checks the stored size before reading the body, and drops the stream when it is over 1 MB", async () => {
    const destroy = vi.fn();
    const transformToByteArray = vi.fn();
    s3Send.mockResolvedValueOnce({ ContentLength: MAX_RAW_BYTES + 1, Body: { destroy, transformToByteArray } });
    const out = await run([record()], { readRaw: undefined });
    expect(out).toEqual({ ok: true, outcomes: ["too_big"] });
    expect(s3Send.mock.calls[0][0].input).toEqual({ Bucket: ENV.BUCKET, Key: `raw/${MESSAGE_ID}` });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(transformToByteArray).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    // An unknown length is not small: it is skipped the same way.
    s3Send.mockResolvedValueOnce({ ContentLength: undefined, Body: { destroy, transformToByteArray } });
    expect((await run([record()], { readRaw: undefined })).outcomes).toEqual(["too_big"]);

    // At exactly the limit it is read and posted.
    s3Send.mockResolvedValueOnce({
      ContentLength: Buffer.byteLength(TEXT_MAIL),
      Body: { transformToByteArray: async () => new Uint8Array(Buffer.from(TEXT_MAIL)) },
    });
    expect((await run([record()], { readRaw: undefined })).outcomes).toEqual(["posted"]);
  });

  it("logs an unknown recipient once and posts nothing", async () => {
    const out = await run([record({ recipients: [`acme3@${DOMAIN}`] })]);
    expect(out).toEqual({ ok: true, outcomes: ["unknown_recipient"] });
    expect(logs).toEqual([`inbound mail ${MESSAGE_ID} skipped one recipient: unknown carrier`]);
    expect(readRaw).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the parsed text once per carrier with the key, the SES message id and the verified sender", async () => {
    const out = await run([record({ recipients: [`acme@${DOMAIN}`, `ACME@${DOMAIN}`, `acme2@${DOMAIN}`, `ac@${DOMAIN}`] })]);
    expect(out).toEqual({ ok: true, outcomes: ["posted", "posted"] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://main.example.amplifyapp.com/api/internal/inbound");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({ "content-type": "application/json", "x-inbound-key": KEY });
    expect(JSON.parse(init.body)).toEqual({
      tenantId: ACME,
      messageId: MESSAGE_ID,
      fromAddress: "pat@example.net",
      subject: "Lumper at the dock",
      text: "Need a $300 advance for diesel at the Joliet yard.",
      receivedAt: "2026-11-02T16:00:00.000Z",
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).tenantId).toBe(ACME2);
    // The key is read once for the invocation.
    expect(readKey).toHaveBeenCalledTimes(1);
    expect(readKey).toHaveBeenCalledWith(ENV.SECRET_ARN);
    expect(logs.filter((l) => l.includes("unknown carrier"))).toHaveLength(1);
    noSecretsInLogs();
  });

  it("sends no sender address unless the message passed DMARC", async () => {
    for (const dmarc of ["FAIL", "GRAY", "PROCESSING_FAILED"]) {
      fetchMock.mockClear();
      await run([record({ dmarc })]);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).fromAddress, dmarc).toBeNull();
    }
    expect(logs.some((l) => l.endsWith("sender not verified: no driver match"))).toBe(true);
    noSecretsInLogs();
  });

  it("takes the text of an HTML-only message without its tags, scripts or styles", async () => {
    readRaw.mockResolvedValueOnce({ tooBig: false, bytes: Buffer.from(HTML_MAIL) });
    await run([record()]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toMatch(/^Waited\s4\shours\s+at the dock$/);
    expect(body.text).not.toMatch(/[<>]|color|x\(\)/);
    expect(body.subject).toBe("Detention");
    // With no text part at all, the HTML is stripped here.
    expect(bodyText({ text: "", html: "<style>p{}</style><p>Waited&nbsp;4 hours</p><script>x()</script>" })).toBe(
      "Waited 4 hours",
    );
    expect(bodyText({ text: "x".repeat(MAX_TEXT_CHARS + 50) })).toHaveLength(MAX_TEXT_CHARS);
  });

  it("skips a failed virus scan, a missing or malformed message id, and a message with no text", async () => {
    expect((await run([record({ virus: "FAIL" })])).outcomes).toEqual(["virus"]);
    expect((await run([record({ messageId: "../raw/other" })])).outcomes).toEqual(["no_message_id"]);
    readRaw.mockResolvedValueOnce({ tooBig: false, bytes: Buffer.from(TEXT_MAIL.replace(/Need a[^\r]*/, "")) });
    expect((await run([record()])).outcomes).toEqual(["empty"]);
    // A parse that throws is final, not retried.
    expect((await run([record()], { parse: async () => Promise.reject(new TypeError("bad")) })).outcomes).toEqual([
      "unparsable",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
  });

  it("throws for a retry on a timeout, a 5xx or a retryable refusal, and keeps any other refusal final", async () => {
    fetchMock.mockResolvedValueOnce(answer(503, { error: "unavailable", retryable: true }));
    await expect(run([record()])).rejects.toThrow(/retried/);
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("slow"), { name: "TimeoutError" }));
    await expect(run([record()])).rejects.toThrow(/retried/);
    expect(logs.some((l) => l.includes("http=0") && l.includes("failure=TimeoutError"))).toBe(true);
    fetchMock.mockResolvedValueOnce(answer(429, { error: "daily_cap", retryable: true }));
    await expect(run([record()])).rejects.toThrow(/retried/);

    // Every carrier is tried before the throw.
    fetchMock.mockResolvedValueOnce(answer(500, {})).mockResolvedValueOnce(answer(202, { id: ROW, status: "received" }));
    fetchMock.mockClear();
    await expect(run([record({ recipients: [`acme@${DOMAIN}`, `acme2@${DOMAIN}`] })])).rejects.toThrow(/retried/);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    for (const [status, error] of [
      [403, "disabled"],
      [403, "forbidden"],
      [400, "bad_request"],
    ] as const) {
      fetchMock.mockResolvedValueOnce(answer(status, { error, retryable: false }));
      expect((await run([record()])).outcomes).toEqual(["refused"]);
    }
    expect(logs).toContain(`inbound mail ${MESSAGE_ID} tenant=${ACME} http=403 id=- status=- error=disabled`);
    noSecretsInLogs();
  });

  it("never echoes an answer's free text into the log", async () => {
    fetchMock.mockResolvedValueOnce(answer(400, { error: "the text said diesel", id: "not-a-row", status: "weird" }));
    await run([record()]);
    expect(logs).toContain(`inbound mail ${MESSAGE_ID} tenant=${ACME} http=400 id=- status=- error=-`);
    noSecretsInLogs();
  });

  it("posts nothing when it is not configured or its key is unreadable", async () => {
    for (const env of [
      { ...ENV, APP_URL: "http://main.example.amplifyapp.com" },
      { ...ENV, APP_URL: undefined },
      { ...ENV, TENANTS: "" },
      { ...ENV, TENANTS: "acme" },
      { ...ENV, DOMAIN: "" },
      { ...ENV, BUCKET: "" },
      { ...ENV, SECRET_ARN: "" },
    ]) {
      expect(readConfig(env)).toBeNull();
      expect(await run([record()], { env })).toEqual({ ok: false, category: "not_configured" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readRaw).not.toHaveBeenCalled();

    readKey.mockResolvedValueOnce("short");
    await expect(run([record()])).rejects.toThrow(/key unreadable/);
    readKey.mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    await expect(run([record()])).rejects.toThrow(/key unreadable/);
    expect(logs).toContain("inbound mail could not read its key: AccessDeniedException");
    expect(fetchMock).not.toHaveBeenCalled();
    noSecretsInLogs();
  });
});
