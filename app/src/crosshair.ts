// Crosshair model shared by the builder screen, the overlay page and the main process.
// Pure data and checks only: nothing here touches the DOM or Electron.

export type XhStyle = "cross" | "t" | "dot" | "circle";
export type XhAnim = "none" | "pulse" | "breathe" | "spin";

export interface Crosshair {
  id: string;
  name: string;
  /** "builder" draws the shapes below; "code" shows the HTML and CSS written by the user. */
  kind: "builder" | "code";
  style: XhStyle;
  /** Arm length, thickness, gap from the center and center dot size, in screen pixels. */
  length: number;
  thickness: number;
  gap: number;
  dot: number;
  /** 20 to 100. */
  opacity: number;
  color: string;
  /** Glow radius in pixels. 0 is off. */
  glow: number;
  /** Dark edge around the shapes, in pixels. 0 is off. */
  outline: number;
  outlineColor: string;
  /** A thin line in a second color down the middle of each arm, so it stays readable on any background. */
  core: boolean;
  coreColor: string;
  anim: XhAnim;
  /** 0.5 to 3. */
  speed: number;
  html: string;
  css: string;
}

export interface CrosshairState {
  /** Draw the crosshair over the game. */
  overlay: boolean;
  activeId: string;
  /** Pixels from the middle of the chosen monitor. */
  offsetX: number;
  offsetY: number;
  /** Index of the monitor in Windows' list. */
  display: number;
  hotkey: string;
  list: Crosshair[];
}

export const HOTKEYS = ["F6", "F7", "F8", "F9", "F10", "F11", "Ctrl+Alt+X", "Ctrl+Alt+C"];
/** Side of the square overlay window. Custom HTML and CSS gets this much room around the center. */
export const OVERLAY_SIZE = 512;
export const CODE_LIMIT = 20_000;

export const SWATCHES = ["#00FFD5", "#39FF14", "#FFD400", "#FF3D7F", "#FF6A00", "#FFFFFF", "#8A5CFF"];

export const SAMPLE_HTML = `<div class="x"><i></i><i></i><i></i><i></i></div>`;
export const SAMPLE_CSS = `.x { position: relative; width: 0; height: 0; animation: r 3s linear infinite; }
.x i { position: absolute; width: 3px; height: 12px; background: #ff3d7f; box-shadow: 0 0 8px #ff3d7f; }
.x i:nth-child(1) { left: -1px; top: -18px; }
.x i:nth-child(2) { left: -1px; top: 6px; }
.x i:nth-child(3) { left: -18px; top: -1px; transform: rotate(90deg); }
.x i:nth-child(4) { left: 6px; top: -1px; transform: rotate(90deg); }
@keyframes r { to { transform: rotate(360deg); } }`;

export function newCrosshair(id: string, name: string, change: Partial<Crosshair> = {}): Crosshair {
  return {
    id,
    name,
    kind: "builder",
    style: "cross",
    length: 8,
    thickness: 2,
    gap: 5,
    dot: 2,
    opacity: 100,
    color: "#00FFD5",
    glow: 4,
    outline: 1,
    outlineColor: "#000000",
    core: false,
    coreColor: "#FFFFFF",
    anim: "none",
    speed: 1,
    html: SAMPLE_HTML,
    css: SAMPLE_CSS,
    ...change,
  };
}

export const DEFAULT_LIST: Crosshair[] = [
  newCrosshair("teal", "Teal cross"),
  newCrosshair("yellow-t", "Yellow T", { style: "t", color: "#FFD400", length: 10, gap: 4, dot: 0 }),
  newCrosshair("pink-dot", "Pink dot", { style: "dot", color: "#FF3D7F", dot: 4, glow: 6 }),
  newCrosshair("white-core", "White core", { color: "#FF3D7F", core: true, thickness: 4, length: 10, glow: 6 }),
  newCrosshair("spinner", "Spinner (code)", { kind: "code", color: "#FF3D7F" }),
];

export const DEFAULT_STATE: CrosshairState = {
  overlay: false,
  activeId: DEFAULT_LIST[0].id,
  offsetX: 0,
  offsetY: 0,
  display: 0,
  hotkey: "F8",
  list: DEFAULT_LIST,
};

const num = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(v, min), max) : fallback;
const color = (v: unknown, fallback: string) => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toUpperCase() : fallback);
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const text = (v: unknown, max: number, fallback: string) => (typeof v === "string" ? v.slice(0, max) : fallback);

export function cleanCrosshair(raw: unknown, fallbackId: string): Crosshair {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = newCrosshair(fallbackId, "Crosshair");
  const id = typeof r.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(r.id) ? r.id : fallbackId;
  return {
    id,
    name: text(r.name, 40, d.name).trim() || d.name,
    kind: r.kind === "code" ? "code" : "builder",
    style: pick(r.style, ["cross", "t", "dot", "circle"] as const, d.style),
    length: Math.round(num(r.length, 1, 40, d.length)),
    thickness: Math.round(num(r.thickness, 1, 10, d.thickness)),
    gap: Math.round(num(r.gap, 0, 30, d.gap)),
    dot: Math.round(num(r.dot, 0, 12, d.dot)),
    opacity: Math.round(num(r.opacity, 20, 100, d.opacity)),
    color: color(r.color, d.color),
    glow: Math.round(num(r.glow, 0, 20, d.glow)),
    outline: Math.round(num(r.outline, 0, 4, d.outline)),
    outlineColor: color(r.outlineColor, d.outlineColor),
    core: r.core === true,
    coreColor: color(r.coreColor, d.coreColor),
    anim: pick(r.anim, ["none", "pulse", "breathe", "spin"] as const, d.anim),
    speed: Number(num(r.speed, 0.5, 3, d.speed).toFixed(1)),
    html: text(r.html, CODE_LIMIT, d.html),
    css: text(r.css, CODE_LIMIT, d.css),
  };
}

/** Makes any input into a valid state: bad fields fall back to defaults, the active one always exists. */
export function cleanState(raw: unknown): CrosshairState {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const list: Crosshair[] = [];
  if (Array.isArray(r.list)) {
    for (const [i, item] of r.list.slice(0, 50).entries()) {
      const c = cleanCrosshair(item, `xh-${i + 1}`);
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      list.push(c);
    }
  }
  const finalList = list.length > 0 ? list : DEFAULT_LIST;
  const activeId = typeof r.activeId === "string" && finalList.some((c) => c.id === r.activeId) ? r.activeId : finalList[0].id;
  return {
    overlay: r.overlay === true,
    activeId,
    offsetX: Math.round(num(r.offsetX, -400, 400, 0)),
    offsetY: Math.round(num(r.offsetY, -400, 400, 0)),
    display: Math.round(num(r.display, 0, 16, 0)),
    hotkey: typeof r.hotkey === "string" && HOTKEYS.includes(r.hotkey) ? r.hotkey : "F8",
    list: finalList,
  };
}

export const activeCrosshair = (s: CrosshairState): Crosshair => s.list.find((c) => c.id === s.activeId) ?? s.list[0];

/** The page shown for a code crosshair. It runs in a frame that allows no scripts. */
export function codeDocument(c: Pick<Crosshair, "html" | "css">): string {
  return (
    "<!doctype html><meta charset=\"utf-8\">" +
    // The body fills the frame and centers the user's markup, so a zero-size wrapper at (0, 0) lands in the middle.
    "<style>html{margin:0;height:100%;overflow:hidden;background:transparent}body{margin:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:transparent}</style>" +
    `<style>${c.css}</style>${c.html}`
  );
}
