import type { ComputerAction, ComputerButton, ComputerPoint } from "../../ai";

// The runner's own check on what the model asked the browser to do (design 3.3 step 8). The
// platform's safety checks are one guard; this is another, applied to every batch whether or not
// a check was raised. A batch with any action that fails is refused whole: nothing in it runs.

export const VIEWPORT = { width: 1280, height: 800 } as const;
export const MAX_TYPE_CHARS = 200;
export const MAX_DRAG_POINTS = 20;
export const MAX_SCROLL = 5_000;
export const WAIT_MS = 1_000;

const BUTTONS: readonly ComputerButton[] = ["left", "right", "wheel", "back", "forward"];

// Key names the model may press, lower case, to the browser's names. Letters and digits are
// added below. Shift is the only modifier, and only in front of one other key.
const NAMED_KEYS: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  escape: "Escape",
  esc: "Escape",
  space: "Space",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
};

// One key name to the browser's, or null when it is not allowed.
export function keyName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (/^[A-Za-z]$/.test(raw)) return raw.toLowerCase();
  if (/^[0-9]$/.test(raw)) return raw;
  const lower = raw.toLowerCase();
  return Object.hasOwn(NAMED_KEYS, lower) ? NAMED_KEYS[lower] : null;
}

// The chord to press: one allowed key, or Shift and one allowed key. Null otherwise.
export function chordOf(keys: unknown): string | null {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 2) return null;
  if (keys.length === 1) return keyName(keys[0]);
  if (typeof keys[0] !== "string" || keys[0].toLowerCase() !== "shift") return null;
  const key = keyName(keys[1]);
  if (!key) return null;
  return `Shift+${/^[a-z]$/.test(key) ? key.toUpperCase() : key}`;
}

const inX = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < VIEWPORT.width;
const inY = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < VIEWPORT.height;
const scrollAmount = (v: unknown): v is number =>
  Number.isInteger(v) && Math.abs(v as number) <= MAX_SCROLL;
const PRINTABLE = /^[\x20-\x7E]+$/;

function point(raw: unknown): ComputerPoint | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { x, y } = raw as Record<string, unknown>;
  return inX(x) && inY(y) ? { x, y } : null;
}

// One raw action to its typed form, or null when any field is missing or out of bounds.
export function validAction(raw: Record<string, unknown>): ComputerAction | null {
  switch (raw.type) {
    case "click": {
      const { x, y, button } = raw;
      if (!inX(x) || !inY(y) || !BUTTONS.includes(button as ComputerButton)) return null;
      return { type: "click", x, y, button: button as ComputerButton };
    }
    case "double_click": {
      const { x, y } = raw;
      return inX(x) && inY(y) ? { type: "double_click", x, y } : null;
    }
    case "move": {
      const { x, y } = raw;
      return inX(x) && inY(y) ? { type: "move", x, y } : null;
    }
    case "drag": {
      const path = raw.path;
      if (!Array.isArray(path) || path.length < 2 || path.length > MAX_DRAG_POINTS) return null;
      const points = path.map(point);
      return points.every((p): p is ComputerPoint => p !== null) ? { type: "drag", path: points } : null;
    }
    case "keypress": {
      if (!chordOf(raw.keys)) return null;
      return { type: "keypress", keys: [...(raw.keys as string[])] };
    }
    case "scroll": {
      const { x, y, scroll_x: sx, scroll_y: sy } = raw;
      if (!inX(x) || !inY(y) || !scrollAmount(sx) || !scrollAmount(sy)) return null;
      return { type: "scroll", x, y, scrollX: sx, scrollY: sy };
    }
    case "type": {
      const text = raw.text;
      if (typeof text !== "string" || text.length > MAX_TYPE_CHARS || !PRINTABLE.test(text)) return null;
      return { type: "type", text };
    }
    case "screenshot":
      return { type: "screenshot" };
    case "wait":
      return { type: "wait" };
    default:
      return null;
  }
}

export type BatchCheck =
  | { ok: true; actions: ComputerAction[] }
  | { ok: false; reason: "empty_batch" | "too_many_actions" | "invalid_action" };

export function validateBatch(raw: readonly Record<string, unknown>[], maxActions: number): BatchCheck {
  if (raw.length === 0) return { ok: false, reason: "empty_batch" };
  if (raw.length > maxActions) return { ok: false, reason: "too_many_actions" };
  const actions: ComputerAction[] = [];
  for (const r of raw) {
    const a = validAction(r);
    if (!a) return { ok: false, reason: "invalid_action" };
    actions.push(a);
  }
  return { ok: true, actions };
}

// What the trace keeps of an action: its type, coordinates, key names and how many characters
// were typed. Never the typed text (the access code is typed). An unknown type keeps no field.
export type ActionSummary = {
  type: string;
  x?: number;
  y?: number;
  button?: string;
  keys?: string[];
  chars?: number;
  points?: number;
  scrollX?: number;
  scrollY?: number;
};

// A key as the trace shows it. A letter or digit is shown as its kind only: the access code can
// be pressed one key at a time.
function keyLabel(raw: unknown): string {
  if (typeof raw === "string" && raw.toLowerCase() === "shift") return "Shift";
  const key = keyName(raw);
  if (!key) return "?";
  if (/^[a-z]$/.test(key)) return "Letter";
  if (/^[0-9]$/.test(key)) return "Digit";
  return key;
}

const KNOWN = ["click", "double_click", "drag", "keypress", "move", "scroll", "type", "screenshot", "wait"];
const int = (v: unknown) => (Number.isInteger(v) ? (v as number) : undefined);

export function summarize(raw: readonly Record<string, unknown>[]): ActionSummary[] {
  return raw.slice(0, 16).map((r) => {
    const type = typeof r.type === "string" && KNOWN.includes(r.type) ? r.type : "unknown";
    const s: ActionSummary = { type };
    if (type === "unknown") return s;
    const x = int(r.x);
    const y = int(r.y);
    if (x !== undefined) s.x = x;
    if (y !== undefined) s.y = y;
    if (type === "click" && typeof r.button === "string" && BUTTONS.includes(r.button as ComputerButton)) {
      s.button = r.button;
    }
    if (type === "keypress" && Array.isArray(r.keys)) s.keys = r.keys.slice(0, 2).map(keyLabel);
    if (type === "type" && typeof r.text === "string") s.chars = r.text.length;
    if (type === "drag" && Array.isArray(r.path)) s.points = r.path.length;
    if (type === "scroll") {
      const sx = int(r.scroll_x);
      const sy = int(r.scroll_y);
      if (sx !== undefined) s.scrollX = sx;
      if (sy !== undefined) s.scrollY = sy;
    }
    return s;
  });
}

// The plain sentence a person reads on the approval card and in the filmstrip.
export function sentence(s: ActionSummary): string {
  const at = s.x !== undefined && s.y !== undefined ? ` at ${s.x}, ${s.y}` : "";
  switch (s.type) {
    case "click":
      return s.button && s.button !== "left" ? `Click (${s.button} button)${at}` : `Click${at}`;
    case "double_click":
      return `Double-click${at}`;
    case "move":
      return `Move the pointer${at.replace(" at", " to")}`;
    case "drag":
      return `Drag through ${s.points ?? 0} points`;
    case "keypress":
      return `Press ${(s.keys ?? []).join("+") || "a key"}`;
    case "scroll":
      return `Scroll${at}`;
    case "type":
      return `Type ${s.chars ?? 0} character${s.chars === 1 ? "" : "s"}`;
    case "screenshot":
      return "Look at the screen";
    case "wait":
      return "Wait a second";
    default:
      return "An action the runner does not allow";
  }
}

// Summaries read back from a stored row, kept only when each entry has the expected shape.
export function summariesFrom(value: unknown): ActionSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v): ActionSummary[] => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return [];
    const r = v as Record<string, unknown>;
    if (typeof r.type !== "string") return [];
    const s: ActionSummary = { type: KNOWN.includes(r.type) ? r.type : "unknown" };
    for (const k of ["x", "y", "chars", "points", "scrollX", "scrollY"] as const) {
      if (Number.isInteger(r[k])) s[k] = r[k] as number;
    }
    if (typeof r.button === "string" && BUTTONS.includes(r.button as ComputerButton)) s.button = r.button;
    if (Array.isArray(r.keys)) s.keys = r.keys.slice(0, 2).map((k) => (k === "Letter" || k === "Digit" ? k : keyLabel(k)));
    return [s];
  });
}
