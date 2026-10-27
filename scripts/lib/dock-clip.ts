import { buildCarrierPlan } from "../../src/lib/seed/plan";
import type { DemoCarrier } from "../../src/lib/seed/carriers";
import { localDateOf, localTimeOf, parseInstant, type LocalDate } from "../../src/lib/time/local-date";

// The pure half of npm run clips:demo (scripts/make-dock-clip.ts): which seeded stop the clip
// shows, what each of its frames holds, and the overlay text. Everything on screen is invented:
// a seed customer's name, an invented plate and seal, and a camera clock running from the
// seeded instants in the carrier's zone.

export const CLIP_WIDTH = 640;
export const CLIP_HEIGHT = 360;
export const CLIP_FPS = 8;
export const CLIP_SECONDS = 18;
export const CLIP_FRAMES = CLIP_FPS * CLIP_SECONDS;
// The committed clip must leave room under the 700,000-byte upload cap.
export const CLIP_MAX_BYTES = 550_000;
// The base stills are drawn this much larger than the frame so a slow zoom has room.
export const ZOOM_ROOM = 1.1;

export const INVENTED_PLATE = "SYN 4Q21";
export const INVENTED_SEAL = "SL-482113";
export const DOOR_SIGN = "RECEIVING DOOR 7";

export type DockStop = "pickup" | "delivery";

export type DockPlant = {
  loadNumber: string;
  stop: DockStop;
  customerName: string;
  zone: string;
  arrivedAt: string;
  departedAt: string;
};

// The seeded stop's instants, from the same plan the seed writes. Throws when the load or a time
// is missing: a clip of an unknown time would be a made-up record.
export function dockPlant(
  carrier: DemoCarrier,
  anchor: LocalDate,
  loadNumber: string,
  stop: DockStop,
): DockPlant {
  const plan = buildCarrierPlan(carrier, anchor);
  const load = plan.rows.loads.find((l) => l.load_number === loadNumber);
  if (!load) throw new Error(`no load ${loadNumber} in the ${carrier.slug} plan`);
  const customer = plan.rows.customers.find((c) => c.id === load.customer_id);
  const arrivedAt = stop === "pickup" ? load.pickup_arrived_at : load.delivery_arrived_at;
  const departedAt = stop === "pickup" ? load.pickup_departed_at : load.delivery_departed_at;
  if (!customer || !arrivedAt || !departedAt) {
    throw new Error(`load ${loadNumber} has no ${stop} times or customer`);
  }
  return {
    loadNumber,
    stop,
    customerName: customer.name,
    zone: carrier.timezone,
    arrivedAt,
    departedAt,
  };
}

export type Scene = "dock" | "trailer" | "form";

export type FrameSpec = {
  index: number;
  scene: Scene;
  // 1 at the scene's first frame, rising to ZOOM_ROOM at its last.
  zoom: number;
  clock: string;
};

// The shots: the dock door (the worker and the sign), the trailer's rear (the plate), the dock
// door again, then the paper form (the BOL and seal numbers). The clock runs from the arrival
// instant for the first half and from the departure instant for the second. The dock shots sit
// between the plate and the form on purpose: a tracker that follows the plate across a hard cut
// can carry its box onto the next white rectangle with dark letters, and the form is one.
const SHOTS: { scene: Scene; seconds: number }[] = [
  { scene: "dock", seconds: 4 },
  { scene: "trailer", seconds: 3 },
  { scene: "dock", seconds: 5 },
  { scene: "form", seconds: 6 },
];

const pad = (n: number) => String(n).padStart(2, "0");

// "10/22/2026 04:05:12 AM": the date and 12-hour time a dock camera burns in.
export function cameraClock(atMs: number, zone: string): string {
  const instant = new Date(atMs).toISOString();
  const [y, m, d] = localDateOf(instant, zone).split("-");
  const t = localTimeOf(instant, zone);
  const hour12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
  return `${m}/${d}/${y} ${pad(hour12)}:${pad(t.minute)}:${pad(t.second)} ${t.hour < 12 ? "AM" : "PM"}`;
}

export function frameSpecs(plant: DockPlant): FrameSpec[] {
  const arrived = parseInstant(plant.arrivedAt);
  const departed = parseInstant(plant.departedAt);
  const half = CLIP_FRAMES / 2;
  const out: FrameSpec[] = [];
  let index = 0;
  for (const shot of SHOTS) {
    const frames = shot.seconds * CLIP_FPS;
    for (let k = 0; k < frames; k++, index++) {
      const second = Math.floor(index / CLIP_FPS);
      const base = index < half ? arrived : departed;
      const offset = index < half ? second : second - CLIP_SECONDS / 2;
      out.push({
        index,
        scene: shot.scene,
        zoom: 1 + ((ZOOM_ROOM - 1) * k) / Math.max(1, frames - 1),
        clock: cameraClock(base + offset * 1000, plant.zone),
      });
    }
  }
  if (out.length !== CLIP_FRAMES) throw new Error("the shot list does not fill the clip");
  return out;
}

// What Muse Image is asked for. No text, marks or plates: every word on screen is ours.
export const STILL_PROMPTS: Record<Scene, string> = {
  dock:
    "Security camera photo of a freight warehouse loading dock at night under orange sodium " +
    "lights, medium shot. A white semi trailer is backed into an open dock door. One dock worker " +
    "in a high-visibility safety vest and a hard hat stands in the foreground near the camera, " +
    "facing it, head and shoulders large in the frame. No text, no logos, no signs, no license " +
    "plates anywhere.",
  trailer:
    "Security camera photo of the rear of a white semi trailer at a loading dock at night, closed " +
    "swing doors, a blank white rectangular plate holder low and centered on the doors with " +
    "nothing written on it. No text, no logos, no signs anywhere.",
  form:
    "Close-up photo of a gloved hand holding a clipboard with a blank white paper form under " +
    "warehouse lighting. The paper is completely blank. No text, no logos anywhere.",
};

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const FONT = "Helvetica, Arial, sans-serif";
const MONO = "Menlo, Courier New, monospace";

// The scene's printed overlay, drawn onto the base still (so it moves with the zoom), sized for
// a base of width x height.
export function sceneOverlaySvg(
  scene: Scene,
  plant: DockPlant,
  width: number,
  height: number,
): string {
  const s = width / CLIP_WIDTH;
  const parts: string[] = [];
  if (scene === "dock") {
    const w = 330 * s;
    const x = (width - w) / 2;
    parts.push(
      `<rect x="${x}" y="${18 * s}" width="${w}" height="${64 * s}" rx="${4 * s}" fill="#0f3d2e" stroke="#e8e8e8" stroke-width="${2 * s}"/>`,
      `<text x="${width / 2}" y="${44 * s}" font-family="${FONT}" font-weight="700" font-size="${19 * s}" fill="#ffffff" text-anchor="middle">${escapeXml(plant.customerName.toUpperCase())}</text>`,
      `<text x="${width / 2}" y="${70 * s}" font-family="${FONT}" font-weight="700" font-size="${17 * s}" fill="#ffd34d" text-anchor="middle">${escapeXml(DOOR_SIGN)}</text>`,
    );
  } else if (scene === "trailer") {
    const w = 172 * s;
    const h = 62 * s;
    const x = (width - w) / 2;
    const y = height * 0.66;
    parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${6 * s}" fill="#f7f7f2" stroke="#1d2a5c" stroke-width="${3 * s}"/>`,
      `<text x="${width / 2}" y="${y + 42 * s}" font-family="${FONT}" font-weight="700" font-size="${28 * s}" fill="#1d2a5c" text-anchor="middle">${escapeXml(INVENTED_PLATE)}</text>`,
    );
  } else {
    const w = 360 * s;
    const h = 210 * s;
    const x = (width - w) / 2;
    const y = (height - h) / 2;
    const line = (dy: number, text: string, size: number, weight = 700) =>
      `<text x="${x + 24 * s}" y="${y + dy * s}" font-family="${FONT}" font-weight="${weight}" font-size="${size * s}" fill="#111111">${escapeXml(text)}</text>`;
    parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fbfbf7" stroke="#9a9a90" stroke-width="${1.5 * s}"/>`,
      line(40, "BILL OF LADING", 24),
      `<line x1="${x + 24 * s}" y1="${y + 54 * s}" x2="${x + w - 24 * s}" y2="${y + 54 * s}" stroke="#333333" stroke-width="${1.5 * s}"/>`,
      line(100, `BOL NO. ${plant.loadNumber}`, 26),
      line(150, `SEAL NO. ${INVENTED_SEAL}`, 26),
      line(188, "SAMPLE - SYNTHETIC DEMO RECORD", 12, 400),
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("")}</svg>`;
}

// The camera's own clock, fixed in the frame's bottom left, on top of the zoomed picture.
export function clockSvg(clock: string): string {
  const y = CLIP_HEIGHT - 40;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CLIP_WIDTH}" height="${CLIP_HEIGHT}">` +
    `<rect x="10" y="${y}" width="292" height="30" fill="#000000" fill-opacity="0.6"/>` +
    `<text x="18" y="${y + 22}" font-family="${MONO}" font-weight="700" font-size="19" fill="#ffffff">${escapeXml(clock)}</text>` +
    `<rect x="${CLIP_WIDTH - 80}" y="${y}" width="70" height="30" fill="#000000" fill-opacity="0.6"/>` +
    `<text x="${CLIP_WIDTH - 18}" y="${y + 22}" font-family="${MONO}" font-weight="700" font-size="17" fill="#ffffff" text-anchor="end">CAM 2</text>` +
    `</svg>`
  );
}

// The crop of a base still for one frame: centered, shrinking from the whole base as the zoom
// rises, always the frame's aspect.
export function cropFor(zoom: number, width: number, height: number) {
  const w = Math.round(width / zoom);
  const h = Math.round(height / zoom);
  return { left: Math.round((width - w) / 2), top: Math.round((height - h) / 2), width: w, height: h };
}
