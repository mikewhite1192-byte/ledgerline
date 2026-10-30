import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

// The nightly sweep kicker (PaydayCopilotSweep). The schedule that invokes it ships DISABLED, and
// the app refuses it unless sweepScheduleEnabled is on. For each carrier in TENANT_IDS it asks the
// app to start a sweep of the open week, then carries the run on one slice at a time while time
// is left. A run it cannot finish is carried on by the sweep page when someone opens it. It never
// approves anything: the app's sweep login can only draft. The key is read from Secrets Manager
// and never logged; each log line names the call, the carrier, the HTTP status and the run's
// status only.
//
// The same Lambda is the desk loop's kicker: an event {"job":"desk"} (its own schedule, also
// shipped DISABLED) wakes each carrier's desk loop at /api/internal/desk instead, and keeps waking
// it while the app answers "more". Any other event (the nightly rule sends none) is the sweep.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_SHAPE = /^[\x21-\x7e]{32,512}$/;
const STATUSES = new Set(["running", "done", "failed"]);
const MAX_ADVANCES = 15;
const CALL_TIMEOUT_MS = 25_000;
// Room left for one more call before the Lambda's own timeout.
const RESERVE_MS = CALL_TIMEOUT_MS + 5_000;
// A desk wake may run to its route's 30 s limit (a voice note's step alone may take 27 s), so the
// kicker waits past that limit: the route's own answer comes back instead of a cut-off read as
// unknown and tried again.
const DESK_CALL_TIMEOUT_MS = 35_000;
const DESK_RESERVE_MS = DESK_CALL_TIMEOUT_MS + 5_000;
const BUSY_WAIT_MS = 2_000;
const DESK_STATUSES = new Set(["done", "more", "busy"]);
const MAX_DESK_WAKES = 12;
const PATHS = { sweep: "/api/internal/sweep", desk: "/api/internal/desk" };

export function readConfig(env, job = "sweep") {
  const tenants = String(env.TENANT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  let url = null;
  try {
    const base = new URL(String(env.APP_URL ?? ""));
    if (base.protocol === "https:" && base.username === "" && base.password === "") {
      url = new URL(job === "desk" ? PATHS.desk : PATHS.sweep, base).toString();
    }
  } catch {
    url = null;
  }
  const secretArn = String(env.SECRET_ARN ?? "");
  if (!url || secretArn === "" || tenants.length === 0 || !tenants.every((t) => UUID.test(t))) return null;
  return { url, tenants: [...new Set(tenants)], secretArn };
}

async function readKey(secretArn) {
  const client = new SecretsManagerClient({});
  const out = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const key = typeof out.SecretString === "string" ? out.SecretString : "";
  if (!KEY_SHAPE.test(key)) throw new Error("the key has the wrong shape");
  return key;
}

// One POST. A timeout or a network failure is status 0: unknown, never success.
async function post(url, key, body, timeoutMs = CALL_TIMEOUT_MS) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sweep-key": key },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json: json && typeof json === "object" ? json : {} };
  } catch (err) {
    return { status: 0, json: {}, failure: err instanceof Error ? err.name : "unknown" };
  }
}

// Only fixed shapes reach the log: a uuid, a known status, a short error category.
function logLine(call, tenantId, res) {
  const runId = typeof res.json.runId === "string" && UUID.test(res.json.runId) ? res.json.runId : "-";
  const status = STATUSES.has(res.json.status) ? res.json.status : "-";
  const error = typeof res.json.error === "string" && /^[a-z_]{1,40}$/.test(res.json.error) ? res.json.error : "-";
  console.log(
    `sweep kicker ${call} tenant=${tenantId} http=${res.status} run=${runId} status=${status} error=${error}` +
      (res.failure ? ` failure=${res.failure}` : ""),
  );
}

function timeLeft(context) {
  return context && typeof context.getRemainingTimeInMillis === "function"
    ? context.getRemainingTimeInMillis()
    : Number.POSITIVE_INFINITY;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function kick(url, key, tenantId, context) {
  const start = await post(url, key, { action: "start", tenantId });
  logLine("start", tenantId, start);
  const runId = start.json.runId;
  if (start.status !== 200 || typeof runId !== "string" || !UUID.test(runId)) return "not_started";
  for (let i = 0; i < MAX_ADVANCES; i++) {
    if (timeLeft(context) < RESERVE_MS) return "left_running";
    const step = await post(url, key, { action: "advance", tenantId, runId });
    logLine("advance", tenantId, step);
    if (step.status === 200 && step.json.status !== "running") return STATUSES.has(step.json.status) ? step.json.status : "unknown";
    if (step.status === 200) continue;
    // Another slice holds the run (busy) or the answer is unknown: wait, then try again.
    if (step.status === 0 || step.json.retryable === true) {
      await wait(BUSY_WAIT_MS);
      continue;
    }
    return "stopped";
  }
  return "left_running";
}

// One carrier's desk loop: wake it, and wake it again while the app answers "more" (work it can
// do now; work carried on waits for the next tick). Another wake holding the loop (busy), or an
// answer that is unknown, waits and tries again.
async function wake(url, key, tenantId, context) {
  for (let i = 0; i < MAX_DESK_WAKES; i++) {
    if (timeLeft(context) < DESK_RESERVE_MS) return "left_open";
    const res = await post(url, key, { action: "wake", tenantId }, DESK_CALL_TIMEOUT_MS);
    deskLogLine(tenantId, res);
    if (res.status === 200 && res.json.status === "more") continue;
    if (res.status === 200 && res.json.status === "done") return "done";
    if ((res.status === 200 && res.json.status === "busy") || res.status === 0 || res.json.retryable === true) {
      await wait(BUSY_WAIT_MS);
      continue;
    }
    return "stopped";
  }
  return "left_open";
}

function deskLogLine(tenantId, res) {
  const wakeId = typeof res.json.wakeId === "string" && UUID.test(res.json.wakeId) ? res.json.wakeId : "-";
  const status = DESK_STATUSES.has(res.json.status) ? res.json.status : "-";
  const error = typeof res.json.error === "string" && /^[a-z_]{1,40}$/.test(res.json.error) ? res.json.error : null;
  console.log(
    `desk kicker wake tenant=${tenantId} http=${res.status} wake=${wakeId} status=${status}` +
      (error ? ` error=${error}` : "") +
      (res.failure ? ` failure=${res.failure}` : ""),
  );
}

export async function handler(event, context) {
  const job = event !== null && typeof event === "object" && event.job === "desk" ? "desk" : "sweep";
  const name = `${job} kicker`;
  const config = readConfig(process.env, job);
  if (!config) {
    console.log(`${name} not configured: APP_URL, TENANT_IDS or SECRET_ARN is missing or invalid`);
    return { ok: false, category: "not_configured" };
  }
  let key;
  try {
    key = await readKey(config.secretArn);
  } catch (err) {
    console.log(`${name} could not read its key: ${err instanceof Error ? err.name : "unknown"}`);
    return { ok: false, category: "not_configured" };
  }
  const outcomes = {};
  for (const tenantId of config.tenants) {
    outcomes[tenantId] = job === "desk" ? await wake(config.url, key, tenantId, context) : await kick(config.url, key, tenantId, context);
  }
  console.log(`${name} finished: ${Object.values(outcomes).join(",")}`);
  return { ok: Object.values(outcomes).every((o) => o === "done"), outcomes };
}
