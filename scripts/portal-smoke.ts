import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright-core";
import { flags } from "../src/config/flags";
import { createPgDb } from "../src/lib/db/pg";
import type { Db } from "../src/lib/db/types";
import { chromiumPath } from "../src/lib/portal/config";
import { blockOffOriginSockets, openPlaywrightDriver } from "../src/lib/portal/runner/playwright-driver";
import { mintSession } from "../src/lib/portal/session";
import type { PortalPlan } from "../src/lib/seed/portal";
import { clearTenantPortal, seedTenantPortal } from "../src/lib/seed/portal-db";
import { localDatabaseUrl } from "./lib/local-db";

// npm run portal:smoke, on this machine only, never in CI. Starts the dev server against a
// throwaway tenant in the local database, opens the portal headless, signs in with a minted code
// and downloads the signed POD; then has the runner's own browser sign itself in with a second
// code, and checks the socket rule closes a WebSocket to another origin while one to the portal
// goes through. Prints five lines and removes everything it made, failure paths included. The portal answers only while portalRunnerEnabled is on, so this is run with the flag
// turned on locally and never committed that way. PORTAL_CHROMIUM_PATH picks a local Chrome
// when the browser playwright-core expects is not installed.

const PORT = Number(process.env.PORTAL_SMOKE_PORT || 3917);
const ORIGIN = `http://localhost:${PORT}`;
const READY_MS = 180_000;
const STEP_MS = 30_000;
const SIGNER = "Dana Reyes";

function fail(message: string): never {
  throw new Error(message);
}

async function answers(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
    return res.status;
  } catch {
    return null;
  }
}

async function waitForServer(url: string, server: ChildProcess): Promise<void> {
  const until = Date.now() + READY_MS;
  while (Date.now() < until) {
    if (server.exitCode !== null) fail(`the dev server exited with code ${server.exitCode}`);
    const status = await answers(url);
    if (status === 200) return;
    if (status === 404) fail("the portal answered 404: portalRunnerEnabled is off in the server's flags");
    await new Promise((r) => setTimeout(r, 1_000));
  }
  fail(`the dev server did not answer within ${READY_MS / 1000} seconds`);
}

function digits(id: string, n: number): string {
  return String(parseInt(id.replace(/-/g, "").slice(0, 8), 16) % 10 ** n).padStart(n, "0");
}

async function createTenant(admin: Db, tenantId: string, loadId: string, plan: PortalPlan): Promise<void> {
  const customerId = randomUUID();
  await admin.withTenant(tenantId, async (q) => {
    await q.execute("INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, $3)", [
      `portal-smoke-${tenantId.slice(0, 8)}`,
      "Portal Smoke Carrier",
      "America/Chicago",
    ]);
    await q.execute(
      "INSERT INTO customers (id, tenant_id, code, name, terms_days, city, state)" +
        " VALUES (CAST($1 AS uuid), current_tenant_id(), 'PS-1', 'Sample Shipper Co', 30, 'Joliet', 'IL')",
      [customerId],
    );
    await q.execute(
      "INSERT INTO loads (id, tenant_id, load_number, customer_id, status, origin_city, origin_state, dest_city," +
        " dest_state, pickup_on, loaded_miles) VALUES (CAST($1 AS uuid), current_tenant_id(), 'PS-1001'," +
        " CAST($2 AS uuid), 'planned', 'Gary', 'IN', 'Joliet', 'IL', CAST('2026-10-20' AS date), 120)",
      [loadId, customerId],
    );
  });
  await seedTenantPortal(admin, tenantId, plan);
}

function planFor(tenantId: string, loadId: string): PortalPlan {
  return {
    carrierNumber: `MC-9${digits(tenantId, 5)}`,
    carrierName: "Portal Smoke Carrier",
    loads: [
      {
        id: randomUUID(),
        loadId,
        loadNumber: "PS-1001",
        reference: `FFE-9${digits(loadId, 5)}`,
        shipperName: "Sample Shipper Co",
        consigneeName: "Sample Receiver Inc",
        consigneeCity: "Joliet",
        consigneeState: "IL",
        scheduledFrom: "2026-10-20T13:00:00.000Z",
        scheduledTo: "2026-10-20T15:00:00.000Z",
        checkedIn: "2026-10-20T14:05:00.000Z",
        checkedOut: "2026-10-20T16:10:00.000Z",
        facilityTimeZone: "America/Chicago",
        podStatus: "available",
        podSignedBy: SIGNER,
        podSignedAt: "2026-10-20T16:12:00.000Z",
        notes: null,
        seedKey: null,
      },
    ],
  };
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function stopServer(server: ChildProcess | null): Promise<void> {
  if (!server?.pid || server.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = setTimeout(() => {
      try {
        process.kill(-server.pid!, "SIGKILL");
      } catch {
        // Already gone.
      }
      resolve();
    }, 10_000);
    server.once("exit", () => {
      clearTimeout(done);
      resolve();
    });
    try {
      process.kill(-server.pid!, "SIGTERM");
    } catch {
      clearTimeout(done);
      resolve();
    }
  });
}

async function main(): Promise<void> {
  if (process.env.DB_CLUSTER_ARN) fail("refused: DB_CLUSTER_ARN is set, and this runs only against a local database");
  if (!flags.portalRunnerEnabled) {
    fail("the portal is off: turn portalRunnerEnabled on in src/config/flags.ts locally, run this, then turn it back off");
  }
  const adminUrl = localDatabaseUrl();
  const appUrl = new URL(adminUrl);
  appUrl.username = "payday_app";
  appUrl.password = "";
  if ((await answers(`${ORIGIN}/`)) !== null) fail(`refused: something already answers on ${ORIGIN}`);

  const admin = createPgDb({ connectionString: adminUrl.toString() });
  const tenantId = randomUUID();
  const loadId = randomUUID();
  const plan = planFor(tenantId, loadId);
  const reference = plan.loads[0].reference;
  let server: ChildProcess | null = null;
  let browser: Browser | null = null;
  const log: string[] = [];
  try {
    await createTenant(admin, tenantId, loadId, plan);
    const seeded = await admin.withTenant(tenantId, (q) =>
      q.query<{ hash: string }>("SELECT pod_content_hash AS hash FROM portal_loads WHERE reference = $1", [reference]),
    );
    const expectedHash = seeded[0]?.hash ?? fail("the seeded POD has no content hash");
    const minted = await admin.withTenant(tenantId, (q) =>
      mintSession(q, { runId: null, createdBy: "portal-smoke", now: new Date() }),
    );
    const forRunner = await admin.withTenant(tenantId, (q) =>
      mintSession(q, { runId: null, createdBy: "portal-smoke", now: new Date() }),
    );

    server = spawn("npx", ["next", "dev", "--port", String(PORT)], {
      detached: true,
      env: { ...process.env, DATABASE_URL: appUrl.toString(), PORTAL_BASE_URL: ORIGIN },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const keep = (chunk: Buffer) => {
      log.push(...chunk.toString("utf8").split("\n").filter(Boolean));
      if (log.length > 40) log.splice(0, log.length - 40);
    };
    server.stdout?.on("data", keep);
    server.stderr?.on("data", keep);
    await waitForServer(`${ORIGIN}/portal?t=${tenantId}`, server);

    browser = await chromium.launch({ headless: true, executablePath: chromiumPath() ?? undefined });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(STEP_MS);
    await page.goto(`${ORIGIN}/portal?t=${tenantId}`);
    await page.fill('input[name="carrierNumber"]', plan.carrierNumber);
    await page.fill('input[name="code"]', minted.code);
    await page.click('button[type="submit"]');
    await page.waitForURL(`${ORIGIN}/portal/loads`);
    console.log(`sign-in  ok  ${plan.carrierNumber} with a one-time code reached /portal/loads`);

    await page.goto(`${ORIGIN}/portal/loads/${reference}`);
    const text = await page.locator("body").innerText();
    if (!text.includes(`signed by ${SIGNER}`)) fail(`the detail page for ${reference} does not show the signer`);
    if (!text.includes("Not a real company")) fail("the detail page has no footer disclaimer");
    console.log(`detail   ok  ${reference} shows the signer and the footer disclaimer`);

    const [download] = await Promise.all([page.waitForEvent("download"), page.click('a[href$="/pod"]')]);
    const stream = (await download.createReadStream()) ?? fail("the download has no content");
    const bytes = await readAll(stream);
    if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") fail("the download is not a PDF");
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== expectedHash) fail("the downloaded POD does not match the seeded hash");
    console.log(`pod      ok  ${bytes.length} bytes, a PDF whose sha256 matches the seeded POD`);

    const driver = await openPlaywrightDriver({ origin: ORIGIN, podMaxBytes: flags.portalRunLimits.podMaxBytes, recordDir: null });
    try {
      await driver.signIn(`${ORIGIN}/portal?t=${tenantId}`, { carrierNumber: plan.carrierNumber, code: forRunner.code });
      if (new URL(driver.url()).pathname !== "/portal/loads") fail("the runner's browser did not get past the sign-in form");
    } finally {
      await driver.close();
    }
    console.log("driver   ok  the runner's browser typed its own code and reached /portal/loads");

    const guarded = await browser.newContext();
    await blockOffOriginSockets(guarded, ORIGIN);
    const probe = await guarded.newPage();
    await probe.goto(`${ORIGIN}/portal?t=${tenantId}`);
    // Whether a socket opened, or how it closed: the rule closes with 1008 and its reason.
    const socket = (url: string) =>
      probe.evaluate(
        (u) =>
          new Promise<string>((resolve) => {
            const ws = new WebSocket(u);
            ws.onopen = () => {
              ws.close();
              resolve("open");
            };
            ws.onclose = (e) => resolve(`closed ${e.code} ${e.reason}`);
            setTimeout(() => resolve("timeout"), 5_000);
          }),
        url,
      );
    const offOrigin = await socket("ws://127.0.0.1:9/x");
    if (offOrigin !== "closed 1008 off origin") fail(`an off-origin socket was not closed by the rule (${offOrigin})`);
    const onOrigin = await socket(`ws://localhost:${PORT}/_next/webpack-hmr`);
    if (onOrigin.includes("off origin")) fail("the rule closed a socket to the portal's own origin");
    await guarded.close();
    console.log(`sockets  ok  off-origin: ${offOrigin}; portal origin: ${onOrigin}`);
  } catch (err) {
    if (log.length) console.error(log.slice(-15).join("\n"));
    throw err;
  } finally {
    await browser?.close().catch(() => undefined);
    await stopServer(server);
    // Harmless when the tenant was never written; covers a seed that failed halfway.
    await clearTenantPortal(admin, tenantId);
    await admin.withTenant(tenantId, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    await admin.close();
  }
}

main().catch((err: unknown) => {
  console.error(`portal smoke failed: ${err instanceof Error ? err.message : "unknown"}`);
  process.exit(1);
});
