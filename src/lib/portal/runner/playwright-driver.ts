import type { BrowserContext } from "playwright-core";
import type { ComputerAction } from "../../ai";
import { chromiumPath } from "../config";
import { chordOf, VIEWPORT, WAIT_MS } from "./actions";
import {
  acceptablePod,
  POD_PATH,
  sameOrigin,
  socketOnOrigin,
  type CapturedPod,
  type DriverFactory,
  type PortalDriver,
} from "./driver";

// The real browser: headless Chromium through playwright-core, loaded only when a run starts so
// nothing else pays for it. Locally it uses an installed Chromium (PORTAL_CHROMIUM_PATH, or the
// one playwright-core expects); the production runner supplies its own build later.

const SETTLE_MS = 3_000;
// A click or a key starts its navigation or download a moment after it returns, and a page that
// was idle before reads as idle at once; this gives that request time to begin before settling.
const AFTER_ACTION_MS = 400;
const NAV_TIMEOUT_MS = 15_000;
const ACTION_TIMEOUT_MS = 5_000;

// A 16 pixel dot that follows each click, so the screenshots and any recording show where the
// model pointed. It never takes a click itself.
const CURSOR_SCRIPT = `(() => {
  const place = (x, y) => {
    let dot = document.getElementById("__portal_runner_cursor");
    if (!dot) {
      dot = document.createElement("div");
      dot.id = "__portal_runner_cursor";
      dot.setAttribute("aria-hidden", "true");
      dot.style.cssText = "position:fixed;width:16px;height:16px;margin:-8px 0 0 -8px;" +
        "border-radius:50%;background:rgba(220,38,38,0.55);border:2px solid #fff;" +
        "box-shadow:0 0 0 1px rgba(0,0,0,0.4);pointer-events:none;z-index:2147483647;";
      (document.body || document.documentElement).appendChild(dot);
    }
    dot.style.left = x + "px";
    dot.style.top = y + "px";
  };
  Object.defineProperty(window, "__portalRunnerCursor", { value: place });
})();`;

// What a person sees in a browser's download bar, shown inside the page because headless Chromium
// has no bar: the model needs to see that the download happened.
const DOWNLOADED_SCRIPT = (kb: number) => `(() => {
  const note = document.createElement("div");
  note.setAttribute("role", "status");
  note.textContent = "Download complete: pod.pdf (${kb} KB)";
  note.style.cssText = "position:fixed;left:16px;bottom:16px;padding:12px 16px;background:#111;" +
    "color:#fff;font:600 16px/1.2 Arial,sans-serif;border-radius:6px;z-index:2147483646;";
  (document.body || document.documentElement).appendChild(note);
})();`;

// HTTP routing never sees a WebSocket, so sockets get their own rule: one to any other origin is
// routed to a handler that never calls connectToServer, so it reaches no server, and is closed.
// Registered before any page opens.
export async function blockOffOriginSockets(context: BrowserContext, origin: string): Promise<void> {
  await context.routeWebSocket(
    (url) => !socketOnOrigin(url.href, origin),
    (ws) => ws.close({ code: 1008, reason: "off origin" }),
  );
}

export const openPlaywrightDriver: DriverFactory = async ({ origin, podMaxBytes, recordDir }) => {
  const { chromium } = await import("playwright-core");
  const executablePath = chromiumPath() ?? undefined;
  const browser = await chromium.launch({ headless: true, executablePath });
  let captured: CapturedPod | null = null;
  let announced: CapturedPod | null = null;
  // The POD response being read, so a screenshot is taken only once the capture is decided.
  let podInFlight: Promise<unknown> | null = null;
  try {
    const context = await browser.newContext({
      viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
      deviceScaleFactor: 1,
      acceptDownloads: false,
      serviceWorkers: "block",
      ...(recordDir ? { recordVideo: { dir: recordDir, size: { ...VIEWPORT } } } : {}),
    });
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    await context.addInitScript(CURSOR_SCRIPT);
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      // Every request to any other origin is stopped here, before it leaves the browser.
      if (!sameOrigin(url, origin)) return route.abort("blockedbyclient");
      if (!POD_PATH.test(new URL(url).pathname)) return route.continue();
      const reading = (async () => {
        const response = await route.fetch({ maxRedirects: 0, timeout: NAV_TIMEOUT_MS });
        const body = await response.body();
        const bytes = new Uint8Array(body);
        if (response.status() === 200 && acceptablePod(url, origin, bytes, podMaxBytes)) {
          captured = { bytes, url };
        }
        await route.fulfill({ response, body });
      })();
      podInFlight = reading;
      try {
        await reading;
      } catch {
        // A failed read captures nothing; the request ends here instead of hanging.
        await route.abort("failed").catch(() => undefined);
      } finally {
        if (podInFlight === reading) podInFlight = null;
      }
    });
    await blockOffOriginSockets(context, origin);
    const page = await context.newPage();

    const pointAt = (x: number, y: number) =>
      page
        .evaluate(([px, py]) => {
          const w = window as unknown as { __portalRunnerCursor?: (x: number, y: number) => void };
          w.__portalRunnerCursor?.(px, py);
        }, [x, y] as const)
        .catch(() => undefined);

    const driver: PortalDriver = {
      async open(url, cookie) {
        if (!sameOrigin(url, origin)) throw new Error("the portal URL is not on the portal origin");
        if (cookie) {
          await context.addCookies([
            { name: cookie.name, value: cookie.value, url: `${origin}/portal`, httpOnly: true, sameSite: "Lax" },
          ]);
        }
        await page.goto(url, { waitUntil: "load" });
      },
      async signIn(url, credentials) {
        if (!sameOrigin(url, origin)) throw new Error("the sign-in URL is not on the portal origin");
        await page.goto(url, { waitUntil: "load" });
        const form = page.locator('form[action="/portal/sign-in"]');
        await form.locator('input[name="carrierNumber"]').fill(credentials.carrierNumber);
        await form.locator('input[name="code"]').fill(credentials.code);
        // The portal answers a sign-in with the loads page, or the sign-in page again on a miss.
        await Promise.all([
          page.waitForURL((u) => u.pathname === "/portal/loads" || u.searchParams.get("e") === "1", {
            waitUntil: "load",
          }),
          form.locator('button[type="submit"]').click(),
        ]);
      },
      async run(action: ComputerAction) {
        switch (action.type) {
          case "click":
            await pointAt(action.x, action.y);
            if (action.button === "back") await page.goBack({ waitUntil: "load" });
            else if (action.button === "forward") await page.goForward({ waitUntil: "load" });
            else {
              const button = action.button === "wheel" ? "middle" : action.button;
              await page.mouse.click(action.x, action.y, { button });
            }
            break;
          case "double_click":
            await pointAt(action.x, action.y);
            await page.mouse.dblclick(action.x, action.y);
            break;
          case "move":
            await pointAt(action.x, action.y);
            await page.mouse.move(action.x, action.y);
            break;
          case "drag": {
            const [first, ...rest] = action.path;
            await page.mouse.move(first.x, first.y);
            await page.mouse.down();
            for (const p of rest) await page.mouse.move(p.x, p.y);
            await page.mouse.up();
            break;
          }
          case "keypress": {
            const chord = chordOf(action.keys);
            if (!chord) throw new Error("a key the runner does not allow");
            await page.keyboard.press(chord);
            break;
          }
          case "scroll":
            await pointAt(action.x, action.y);
            await page.mouse.move(action.x, action.y);
            await page.mouse.wheel(action.scrollX, action.scrollY);
            break;
          case "type":
            await page.keyboard.type(action.text);
            break;
          case "screenshot":
            break;
          case "wait":
            await page.waitForTimeout(WAIT_MS);
            break;
        }
      },
      async settle() {
        await page.waitForTimeout(AFTER_ACTION_MS);
        await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => undefined);
        if (podInFlight) {
          await Promise.race([podInFlight.catch(() => undefined), page.waitForTimeout(SETTLE_MS)]);
        }
        if (captured && captured !== announced) {
          announced = captured;
          await page.evaluate(DOWNLOADED_SCRIPT(Math.ceil(captured.bytes.length / 1024))).catch(() => undefined);
        }
      },
      async screenshot() {
        const png = await page.screenshot({ type: "png", fullPage: false });
        return { mime: "image/png", bytes: new Uint8Array(png) };
      },
      url: () => page.url(),
      pod: () => captured,
      async close() {
        await context.close().catch(() => undefined);
        await browser.close().catch(() => undefined);
      },
    };
    return driver;
  } catch (err) {
    await browser.close().catch(() => undefined);
    throw err;
  }
};
