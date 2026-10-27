// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RedactionPlan } from "@/lib/clips/redaction";
import type { ClipView, StoredReading } from "@/lib/clips/types";
import { ClipViewer, clipMarks } from "./clip-viewer";
import { ClipUploader } from "./redactor";

// The viewer asks for the clip and its redacted file, and nothing else: there is no raw file to
// ask for. The uploader checks the browser before it sends a byte.

const ID = "22222222-2222-4222-8222-222222222222";
const READING: StoredReading = {
  arrival: { clockText: "04:05:12 AM", dateText: "10/22/2026", atSeconds: 1.2, confidence: "high" },
  departure: { clockText: "11:25:03 AM", dateText: "10/22/2026", atSeconds: 16.5, confidence: "high" },
  bolNumber: { value: "BR-L10216", atSeconds: 8, confidence: "high" },
  sealNumber: null,
  doorText: "RECEIVING DOOR 7",
  agreement: { result: "matches", arrivalMinutesOff: 0, departureMinutesOff: 0 },
};
const CLIP: ClipView = {
  id: ID,
  loadId: "33333333-3333-4333-8333-333333333333",
  loadNumber: "BR-L10216",
  stop: "delivery",
  filename: "dock.mp4",
  status: "read",
  width: 640,
  height: 360,
  fps: 8,
  frameCount: 144,
  durationMs: 18_000,
  planReady: true,
  redactedByteLength: 1234,
  reading: READING,
  coverage: { faceFrames: 72, plateFrames: 25 },
  createdAt: "2026-10-27T03:00:00.000Z",
  redactedAt: "2026-10-27T03:00:10.000Z",
  readAt: "2026-10-27T03:00:20.000Z",
};
const PLAN: RedactionPlan = {
  width: 640,
  height: 360,
  frameCount: 144,
  frames: Array.from({ length: 144 }, () => []),
  coverage: { faceFrames: 72, plateFrames: 25, boxes: 0 },
};

// The redacted file as the file route serves it: bytes with a video/mp4 content type. A body built
// from this test browser's own Blob is not one the runtime's Response can read (one Node version
// throws, another reads it as the text "[object Blob]"), so the body is the bytes themselves.
const FILE_BYTES = Uint8Array.of(0, 0, 0, 8);
const fileResponse = () => new Response(FILE_BYTES, { headers: { "content-type": "video/mp4" } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) =>
    url.endsWith("/file")
      ? fileResponse()
      : Response.json({ ok: true, clip: CLIP, plan: PLAN }),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:clip-1"), revokeObjectURL: vi.fn() }));
  // No canvas in this test browser; the overlay simply draws nothing.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("clipMarks", () => {
  it("lists each value read, in clip order", () => {
    expect(clipMarks(READING).map((m) => m.label)).toEqual([
      "Arrival clock 04:05:12 AM",
      "BOL BR-L10216",
      "Departure clock 11:25:03 AM",
    ]);
    expect(clipMarks(null)).toEqual([]);
  });
});

describe("ClipViewer", () => {
  it("fetches only the clip and its redacted file, and plays the file from memory", async () => {
    const { container, unmount } = render(<ClipViewer clipId={ID} />);
    await screen.findByText("Matches the stored stop times");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`/api/clips/${ID}`, `/api/clips/${ID}/file`]);
    const video = container.querySelector("video")!;
    expect(video.getAttribute("src")).toBe("blob:clip-1");
    // The object URL is made from the served file itself: its exact bytes and its video type.
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    const played = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(played.type).toBe("video/mp4");
    expect(new Uint8Array(await played.arrayBuffer())).toEqual(FILE_BYTES);
    expect(screen.getByText("Door sign: RECEIVING DOOR 7")).toBeTruthy();
    expect(screen.getByText(/faces in 72 frames, plates in 25/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "BOL BR-L10216 at 0:08" }));
    expect(video.currentTime).toBe(8);
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:clip-1");
  });

  it("shows a category message, never the server's text, when the clip cannot be loaded", async () => {
    fetchMock.mockImplementation(async () => Response.json({ error: "not_found", retryable: false }, { status: 404 }));
    render(<ClipViewer clipId={ID} />);
    expect(await screen.findByText("That load or clip was not found.")).toBeTruthy();
  });

  it("keeps the clip and its button when a reading is refused, and reloads the clip's status", async () => {
    const waiting: ClipView = { ...CLIP, status: "budget", reading: null, readAt: null };
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/file")
        ? fileResponse()
        : url.endsWith("/read")
          ? Response.json({ error: "budget", retryable: true }, { status: 409 })
          : Response.json({ ok: true, clip: waiting, plan: PLAN }),
    );
    const { container } = render(<ClipViewer clipId={ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Read the clip" }));
    expect(await screen.findByText("The AI spending cap was reached. Try again later.")).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `/api/clips/${ID}`,
      `/api/clips/${ID}/file`,
      `/api/clips/${ID}/read`,
      `/api/clips/${ID}`,
      `/api/clips/${ID}/file`,
    ]);
    expect(await screen.findByRole("button", { name: "Read the clip" })).toBeTruthy();
    expect(container.querySelector("video")).not.toBeNull();
  });
});

describe("ClipUploader", () => {
  it("refuses in a browser that cannot blur video before any upload", async () => {
    const { container } = render(
      <ClipUploader loads={[{ id: CLIP.loadId, loadNumber: "BR-L10216", label: "BR-L10216" }]} onDone={() => {}} />,
    );
    const input = container.querySelector('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File([Uint8Array.of(0, 0, 0, 8)], "dock.mp4", { type: "video/mp4" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload and blur" }));
    await waitFor(() => expect(screen.getByText(/This browser cannot blur video/)).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is busy from the first submit, so a second one while the file is read starts nothing", async () => {
    const tiny = new Uint8Array(readFileSync(join(__dirname, "../../lib/clips/fixtures/tiny.mp4")));
    vi.stubGlobal("VideoEncoder", Object.assign(function VideoEncoder() {}, { isConfigSupported: async () => ({ supported: true }) }));
    vi.stubGlobal("VideoFrame", function VideoFrame() {});
    fetchMock.mockImplementation(async () => Response.json({ error: "limit", retryable: false }, { status: 429 }));
    let release: (bytes: ArrayBuffer) => void = () => {};
    const file = new File([tiny], "dock.mp4", { type: "video/mp4" });
    const arrayBuffer = vi.fn(() => new Promise<ArrayBuffer>((resolve) => (release = resolve)));
    Object.defineProperty(file, "arrayBuffer", { value: arrayBuffer });
    const { container } = render(
      <ClipUploader loads={[{ id: CLIP.loadId, loadNumber: "BR-L10216", label: "BR-L10216" }]} onDone={() => {}} />,
    );
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    const form = container.querySelector("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Upload and blur" })).toHaveProperty("disabled", true);
    release(tiny.slice().buffer);
    await waitFor(() => expect(screen.getByText(/today's clip limit/)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a file the browser cannot read instead of staying busy", async () => {
    vi.stubGlobal("VideoEncoder", Object.assign(function VideoEncoder() {}, { isConfigSupported: async () => ({ supported: true }) }));
    vi.stubGlobal("VideoFrame", function VideoFrame() {});
    const file = new File([Uint8Array.of(0, 0, 0, 8)], "dock.mp4", { type: "video/mp4" });
    Object.defineProperty(file, "arrayBuffer", { value: () => Promise.reject(new Error("NotReadableError")) });
    const { container } = render(
      <ClipUploader loads={[{ id: CLIP.loadId, loadNumber: "BR-L10216", label: "BR-L10216" }]} onDone={() => {}} />,
    );
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload and blur" }));
    await waitFor(() => expect(screen.getByText(/could not play this file/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Upload and blur" })).toHaveProperty("disabled", false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
