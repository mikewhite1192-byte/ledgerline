import type { ComputerAction, ComputerScreenshot } from "../../ai";

// The browser, as the runner sees it. The real one is playwright-driver.ts; tests use a fake. The
// contract every driver keeps:
//   - only the configured origin is reached: any other request is aborted before it leaves;
//   - a download is accepted only from /portal/loads/<reference>/pod, at most podMaxBytes, and
//     only when its bytes start with %PDF-; it is held in memory, never written to disk;
//   - the viewport is 1280 x 800 at device scale 1, so screenshot pixels are action pixels.

export type CapturedPod = { bytes: Uint8Array; url: string };

export type PortalCookie = { name: string; value: string };

export interface PortalDriver {
  // Opens the page, with the portal session cookie when one is given.
  open(url: string, cookie: PortalCookie | null): Promise<void>;
  // Runs one validated action. Throws on any browser error; the runner stops the batch there.
  run(action: ComputerAction): Promise<void>;
  // Waits for the page to go quiet, at most 3 seconds. Never throws.
  settle(): Promise<void>;
  screenshot(): Promise<ComputerScreenshot>;
  // The page's current URL.
  url(): string;
  // The last POD captured since the driver opened, or null.
  pod(): CapturedPod | null;
  close(): Promise<void>;
}

export type DriverOptions = {
  origin: string;
  podMaxBytes: number;
  // Local only: a folder for a video of the run.
  recordDir: string | null;
};

export type DriverFactory = (options: DriverOptions) => Promise<PortalDriver>;

export const PORTAL_COOKIE = "ll_portal";

// The only path a POD download may come from: /portal/loads/FFE-123456/pod.
export const POD_PATH = /^\/portal\/loads\/FFE-[0-9]{6}\/pod$/;

export function isPdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

// Whether a URL is on the allowed origin, compared whole (scheme, host and port).
export function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

// Whether a response may become the run's POD: the right path on the right origin, within the
// size cap, and a PDF.
export function acceptablePod(url: string, origin: string, bytes: Uint8Array, maxBytes: number): boolean {
  if (!sameOrigin(url, origin)) return false;
  if (!POD_PATH.test(new URL(url).pathname)) return false;
  return bytes.length > 0 && bytes.length <= maxBytes && isPdf(bytes);
}
