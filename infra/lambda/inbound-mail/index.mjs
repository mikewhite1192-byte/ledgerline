import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { simpleParser } from "mailparser";

// The inbound mail poster (PaydayCopilotInbound). SES stores each message under raw/<messageId>
// in the mail bucket, then invokes this function with the message's receipt. For each record it
// reads the stored message (skipping one over 1 MB), parses it, and posts the plain text to the
// app's internal inbound route once per carrier the recipients name. The app refuses every post
// unless inboundEmailEnabled and inboxEnabled are on.
//
// A recipient names a carrier only by its whole local part, matched against TENANTS
// (slug=uuid,...): never a prefix, a suffix or a part of one. An unknown recipient is one log line
// and no post. The sender's address is sent only when the receipt's DMARC verdict is PASS, so an
// unverified From never matches a driver. The SES message id is the dedupe key: a retried
// invocation posts the same id and the app keeps one row.
//
// A failed or unknown answer (a timeout, a network failure, a 5xx, or a refusal the app marks
// retryable) throws, so the invocation is retried; any other refusal is final and logged. Log
// lines carry fixed words, ids and HTTP statuses only: never the key, the text, the subject or an
// address.

export const MAX_RAW_BYTES = 1024 * 1024;
export const MAX_TEXT_CHARS = 20_000;
const CALL_TIMEOUT_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const KEY_SHAPE = /^[\x21-\x7e]{32,512}$/;
// SES message ids are letters, digits and hyphens: never a slash or a dot, so raw/<id> stays one key.
const SES_ID = /^[A-Za-z0-9-]{1,128}$/;
const CATEGORY = /^[a-z_]{1,40}$/;
const STATUSES = new Set(["received", "blocked", "triaged", "handed_off", "failed"]);

// TENANTS as a map from whole local part to carrier id, or null when any entry is malformed (the
// stack checks the same shape at synth, so a bad value means the function was changed by hand).
export function parseTenants(raw) {
  const out = new Map();
  const text = String(raw ?? "").trim();
  if (text === "") return out;
  for (const entry of text.split(",")) {
    const [slug, id, ...rest] = entry.trim().split("=");
    if (rest.length > 0 || !SLUG.test(slug ?? "") || !UUID.test(id ?? "") || out.has(slug)) return null;
    out.set(slug, id);
  }
  return out;
}

// The carrier a recipient names: the whole local part, lowercased, looked up exactly; and only
// when the address is at the receiving domain. Anything else is null.
export function tenantFor(recipient, tenants, domain) {
  if (typeof recipient !== "string") return null;
  const address = recipient.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0 || address.indexOf("@") !== at) return null;
  if (address.slice(at + 1) !== domain) return null;
  return tenants.get(address.slice(0, at)) ?? null;
}

export function readConfig(env) {
  let url = null;
  try {
    const base = new URL(String(env.APP_URL ?? ""));
    if (base.protocol === "https:" && base.username === "" && base.password === "") {
      url = new URL("/api/internal/inbound", base).toString();
    }
  } catch {
    url = null;
  }
  const tenants = parseTenants(env.TENANTS);
  const domain = String(env.DOMAIN ?? "").trim().toLowerCase();
  const secretArn = String(env.SECRET_ARN ?? "");
  const bucket = String(env.BUCKET ?? "");
  if (!url || !tenants || tenants.size === 0 || domain === "" || secretArn === "" || bucket === "") return null;
  return { url, tenants, domain, secretArn, bucket };
}

// The plain text of a parsed message: its text part, or its HTML with the tags taken out when it
// has no text part. Cut at MAX_TEXT_CHARS.
export function bodyText(parsed) {
  let text = typeof parsed?.text === "string" ? parsed.text : "";
  if (text.trim() === "" && typeof parsed?.html === "string") {
    text = stripTags(parsed.html)
      .replace(/&nbsp;/gi, " ")
      .replace(/[ \t]+/g, " ");
  }
  return text.trim().slice(0, MAX_TEXT_CHARS);
}

const DROPPED = ["script", "style"];
const NAME_END = " \t\n\r\f/>";

// Whether `name` starts at index `at` (any case) and ends there as a tag name does: at a space,
// a "/" or a ">".
function nameAt(html, at, name) {
  if (html.slice(at, at + name.length).toLowerCase() !== name) return false;
  const next = html.charAt(at + name.length);
  return next !== "" && NAME_END.includes(next);
}

// The index just past the first </name ...> at or after `from`, or -1 when there is none.
function closeAfter(html, from, name) {
  let at = from;
  for (;;) {
    const open = html.indexOf("</", at);
    if (open === -1) return -1;
    if (nameAt(html, open + 2, name)) {
      const gt = html.indexOf(">", open + 2 + name.length);
      return gt === -1 ? -1 : gt + 1;
    }
    at = open + 2;
  }
}

// The HTML's text in one forward pass, so the time grows with the length whatever the markup
// (no pattern here can backtrack): each tag becomes a space, a script or style element is dropped
// with its contents, and a tag or a script or style left open ends the text there.
function stripTags(html) {
  const parts = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      parts.push(html.slice(i));
      break;
    }
    parts.push(html.slice(i, lt), " ");
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) break;
    const dropped = DROPPED.find((name) => nameAt(html, lt + 1, name));
    if (dropped === undefined) {
      i = gt + 1;
      continue;
    }
    const end = closeAfter(html, gt + 1, dropped);
    if (end === -1) break;
    i = end;
  }
  return parts.join("");
}

// The header From's address, only when SES says it passed DMARC (aligned with that From).
export function verifiedFrom(parsed, receipt) {
  if (receipt?.dmarcVerdict?.status !== "PASS") return null;
  const value = parsed?.from?.value;
  if (!Array.isArray(value) || value.length !== 1) return null;
  const address = value[0]?.address;
  return typeof address === "string" && address.length > 0 && address.length <= 320 ? address : null;
}

function defaultDeps() {
  let s3;
  let secrets;
  return {
    async readRaw(bucket, key) {
      s3 ??= new S3Client({});
      const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const size = Number(out.ContentLength);
      if (!Number.isSafeInteger(size) || size > MAX_RAW_BYTES) {
        out.Body?.destroy?.();
        return { tooBig: true, size: Number.isSafeInteger(size) ? size : -1 };
      }
      const bytes = await out.Body.transformToByteArray();
      if (bytes.byteLength > MAX_RAW_BYTES) return { tooBig: true, size: bytes.byteLength };
      return { tooBig: false, bytes: Buffer.from(bytes) };
    },
    async readKey(secretArn) {
      secrets ??= new SecretsManagerClient({});
      const out = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
      return typeof out.SecretString === "string" ? out.SecretString : "";
    },
    parse: (bytes) =>
      simpleParser(bytes, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true, keepCidLinks: false }),
    fetch: (...args) => globalThis.fetch(...args),
    log: (line) => console.log(line),
  };
}

// One POST. A timeout or a network failure is status 0: unknown, never success.
async function post(deps, url, key, body) {
  try {
    const res = await deps.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-inbound-key": key },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json: json && typeof json === "object" ? json : {} };
  } catch (err) {
    return { status: 0, json: {}, failure: err instanceof Error ? err.name : "unknown" };
  }
}

const retryable = (res) => res.status === 0 || res.status >= 500 || res.json.retryable === true;

// Handles one SES record. Returns the outcomes it logged; throws when a post must be retried.
async function handleRecord(record, config, deps, getKey) {
  const mail = record?.ses?.mail;
  const receipt = record?.ses?.receipt;
  const messageId = mail?.messageId;
  if (typeof messageId !== "string" || !SES_ID.test(messageId)) {
    deps.log("inbound mail skipped: no message id");
    return ["no_message_id"];
  }
  const tenantIds = [];
  for (const recipient of Array.isArray(receipt?.recipients) ? receipt.recipients : []) {
    const tenantId = tenantFor(recipient, config.tenants, config.domain);
    if (tenantId === null) deps.log(`inbound mail ${messageId} skipped one recipient: unknown carrier`);
    else if (!tenantIds.includes(tenantId)) tenantIds.push(tenantId);
  }
  if (tenantIds.length === 0) return ["unknown_recipient"];
  if (receipt?.virusVerdict?.status === "FAIL") {
    deps.log(`inbound mail ${messageId} skipped: virus verdict failed`);
    return ["virus"];
  }
  const raw = await deps.readRaw(config.bucket, `raw/${messageId}`);
  if (raw.tooBig) {
    deps.log(`inbound mail ${messageId} skipped: over ${MAX_RAW_BYTES} bytes (${raw.size})`);
    return ["too_big"];
  }
  let parsed;
  try {
    parsed = await deps.parse(raw.bytes);
  } catch (err) {
    // A message that does not parse never will: final, not retried.
    deps.log(`inbound mail ${messageId} skipped: unparsable (${err instanceof Error ? err.name : "unknown"})`);
    return ["unparsable"];
  }
  const text = bodyText(parsed);
  if (text === "") {
    deps.log(`inbound mail ${messageId} skipped: no text`);
    return ["empty"];
  }
  const fromAddress = verifiedFrom(parsed, receipt);
  if (fromAddress === null) deps.log(`inbound mail ${messageId} sender not verified: no driver match`);
  const subject = typeof parsed?.subject === "string" ? parsed.subject.slice(0, 2_000) : null;
  const stamp = new Date(typeof mail.timestamp === "string" ? mail.timestamp : Number.NaN);
  const receivedAt = Number.isNaN(stamp.getTime()) ? new Date().toISOString() : stamp.toISOString();

  const key = await getKey();
  const outcomes = [];
  let retry = false;
  for (const tenantId of tenantIds) {
    const res = await post(deps, config.url, key, { tenantId, messageId, fromAddress, subject, text, receivedAt });
    const id = typeof res.json.id === "string" && UUID.test(res.json.id) ? res.json.id : "-";
    const status = STATUSES.has(res.json.status) ? res.json.status : "-";
    const error = typeof res.json.error === "string" && CATEGORY.test(res.json.error) ? res.json.error : "-";
    deps.log(
      `inbound mail ${messageId} tenant=${tenantId} http=${res.status} id=${id} status=${status} error=${error}` +
        (res.failure ? ` failure=${res.failure}` : ""),
    );
    if (res.status >= 200 && res.status < 300) outcomes.push("posted");
    else if (retryable(res)) {
      outcomes.push("retry");
      retry = true;
    } else outcomes.push("refused");
  }
  // Every carrier was tried first; the retry posts them all again and the app keeps one row each.
  if (retry) throw new Error("inbound mail post must be retried");
  return outcomes;
}

// The Lambda entry point: the real clients and this function's own environment.
export const handler = (event) => handle(event, {});

// `overrides` replaces any of the outside calls (and `env`); tests pass fakes, nothing else does.
export async function handle(event, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const config = readConfig(overrides.env ?? process.env);
  if (!config) {
    deps.log("inbound mail not configured: APP_URL, TENANTS, DOMAIN, BUCKET or SECRET_ARN is missing or invalid");
    return { ok: false, category: "not_configured" };
  }
  // The key is read once per invocation, and only when a record has something to post.
  let key = null;
  const getKey = async () => {
    if (key !== null) return key;
    let value;
    try {
      value = await deps.readKey(config.secretArn);
    } catch (err) {
      deps.log(`inbound mail could not read its key: ${err instanceof Error ? err.name : "unknown"}`);
      throw new Error("inbound mail key unreadable");
    }
    // Trimmed before the shape check, as the app's reader trims the same secret.
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!KEY_SHAPE.test(trimmed)) {
      deps.log("inbound mail could not read its key: wrong shape");
      throw new Error("inbound mail key unreadable");
    }
    key = trimmed;
    return key;
  };
  const records = Array.isArray(event?.Records) ? event.Records : [];
  const outcomes = [];
  for (const record of records) outcomes.push(...(await handleRecord(record, config, deps, getKey)));
  return { ok: true, outcomes };
}
