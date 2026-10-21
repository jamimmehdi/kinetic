import { useCallback, useEffect, useRef, useState } from "react";

// ---- config types (mirror the engine's config.json) -------------------------------------------

export type MouseButtonName = "left" | "right" | "middle" | "back" | "forward";

export type Action =
  | { type: "key"; keys: string[] }
  | { type: "mouse"; button: MouseButtonName }
  | { type: "macro"; id: string }
  | { type: "dpi"; op: "cycle" | "up" | "down" | "set" | "hold"; stage: number }
  | { type: "shift" }
  | { type: "launch"; path: string }
  | { type: "disabled" };

export interface Mapping {
  /** 1 left, 2 right, 3 middle, 4 back, 5 forward, 6 and up are device-specific extras. */
  button: number;
  action: Action;
}

export interface Stage {
  dpi: number;
  dpi_y?: number | null;
}

export type AccelMode = "off" | "linear" | "classic" | "natural" | "sigmoid" | "power" | "jump" | "custom";

export interface Accel {
  mode: AccelMode;
  kind: "sensitivity" | "gain";
  rate: number;
  offset: number;
  limit: number;
  midpoint: number;
  exponent: number;
  speed_cap: boolean;
  per_axis: boolean;
  points: [number, number][];
}

export interface Perf {
  native_dpi: number;
  stages: Stage[];
  active_stage: number;
  independent_xy: boolean;
  accel: Accel;
  rotation: number;
  y_ratio: number;
  angle_snap: boolean;
  smoothing: number;
  raw_movement: boolean;
  scroll: { lines: number; smooth: boolean; reverse: boolean };
  /** With a supported mouse, set the mouse's own DPI to the stage instead of scaling in software. */
  use_hardware: boolean;
}

export interface Profile {
  id: string;
  name: string;
  /** Executable name that activates this profile, lower case. */
  app?: string | null;
  mappings: Mapping[];
  shift_mappings: Mapping[];
  perf: Perf;
}

export type Repeat =
  | { mode: "once" }
  | { mode: "held" }
  | { mode: "toggle" }
  | { mode: "loop"; count: number };

export type MacroEvent =
  | { type: "key_down"; key: string }
  | { type: "key_up"; key: string }
  | { type: "mouse_down"; button: MouseButtonName }
  | { type: "mouse_up"; button: MouseButtonName }
  | { type: "delay"; ms: number }
  | { type: "move"; dx: number; dy: number };

export interface MacroDef {
  id: string;
  name: string;
  repeat: Repeat;
  events: MacroEvent[];
}

export interface LearnedButton {
  vid: number;
  pid: number;
  path_contains: string;
  report_id: number;
  byte_index: number;
  down_value: number;
  up_value: number;
  button: number;
  label: string;
}

export interface EngineConfig {
  profiles: Profile[];
  macros: MacroDef[];
  learned: LearnedButton[];
  auto_switch: boolean;
}

export const DEFAULT_PROFILE = "default";

export const DEFAULT_ACCEL: Accel = {
  mode: "off",
  kind: "sensitivity",
  rate: 0.8,
  offset: 0,
  limit: 2.5,
  midpoint: 4,
  exponent: 2,
  speed_cap: false,
  per_axis: false,
  points: [[0, 1], [4, 1.5], [8, 2.5]],
};

export function defaultPerf(): Perf {
  return {
    native_dpi: 1600,
    // Ascending; the engine keeps them in this order.
    stages: [400, 800, 1200, 1600, 2400, 3200].map((dpi) => ({ dpi })),
    active_stage: 3,
    independent_xy: false,
    accel: { ...DEFAULT_ACCEL, points: DEFAULT_ACCEL.points.map((p) => [...p] as [number, number]) },
    rotation: 0,
    y_ratio: 1,
    angle_snap: false,
    smoothing: 0,
    raw_movement: true,
    scroll: { lines: 3, smooth: false, reverse: false },
    use_hardware: true,
  };
}

export const EMPTY_CONFIG: EngineConfig = {
  profiles: [{ id: DEFAULT_PROFILE, name: "Default", app: null, mappings: [], shift_mappings: [], perf: defaultPerf() }],
  macros: [],
  learned: [],
  auto_switch: true,
};

// ---- messages ----------------------------------------------------------------------------------

export interface ExtraButtonInfo {
  button: number;
  label: string;
}

export interface DeviceInfo {
  id: string;
  name: string;
  vid: number;
  pid: number;
  /** Number of buttons Windows reports for this mouse. */
  buttons: number;
  extras: ExtraButtonInfo[];
}

export interface Telemetry {
  /** Hand speed in counts per millisecond. */
  speed: number;
  /** Measured polling rate. */
  hz: number;
  latency_ms: number;
  /** Acceleration multiplier in use. */
  mult: number;
  moving: boolean;
}

export interface DpiInfo {
  stage: number;
  dpi_x: number;
  dpi_y: number;
  /** What the mouse really runs at. */
  native: number;
  stages: number;
  processing: boolean;
  /** The mouse's own DPI is being set by the app. */
  hardware: boolean;
  /** The DPI was picked with the mouse's own button and is not one of the stages. */
  custom: boolean;
}

/** What a supported mouse reports about itself over its own protocol. */
export interface HardwareInfo {
  connected: boolean;
  vendor: string;
  dpi_x: number | null;
  dpi_y: number | null;
  polling_hz: number | null;
  polling_options: number[];
  can_set_polling: boolean;
  can_set_dpi: boolean;
  /** Percent, when the mouse reports it. */
  battery: number | null;
}

/** A new button the setup guide found and is waiting for a name. */
export interface LearnCandidate {
  button: number;
  vid: number;
  pid: number;
}

export type LearnState =
  | { state: "idle" }
  | { state: "listening"; seconds: number; multi?: boolean }
  | { state: "found"; button: number }
  | { state: "none"; saw_reports: boolean };

export type EngineMessage =
  | { t: "hello"; version: string }
  | { t: "devices"; devices: DeviceInfo[] }
  | { t: "button"; device: string; button: number; down: boolean }
  | { t: "wheel"; device: string; delta: number }
  | { t: "config"; config: EngineConfig }
  | { t: "active"; profile: string; app: string }
  | { t: "apps"; apps: string[] }
  | { t: "macro"; id: string; running: boolean }
  | ({ t: "telemetry" } & Telemetry)
  | ({ t: "dpi" } & DpiInfo)
  | ({ t: "hardware" } & HardwareInfo)
  | { t: "layer"; shift: boolean }
  | { t: "engine"; paused: boolean }
  | ({ t: "learn" } & LearnState)
  | { t: "learn"; state: "candidates"; items: LearnCandidate[] }
  | ({ t: "measure" } & MeasureState)
  | ({ t: "report" } & DeviceReport);

/** What the engine can see about the connected mice, for a support request. */
export interface DeviceReport {
  engine: string;
  windows: string;
  devices: {
    vid: string;
    pid: string;
    name: string;
    buttons: number;
    interfaces: Record<string, unknown>[];
    learned_buttons: Record<string, unknown>[];
  }[];
}

/** The latest button event with the mouse it came from. `n` counts events so repeats are seen. */
export interface ButtonEvent {
  device: string;
  button: number;
  down: boolean;
  n: number;
}

/** The DPI measurement: the user moves the mouse a known distance and we count what the sensor sent. */
export type MeasureState =
  | { state: "idle" }
  | { state: "running"; cm: number; counts: number; device: string | null }
  | { state: "done"; cm: number; counts: number; device: string; dpi: number }
  | { state: "failed"; reason: string };

export interface KineticBridge {
  onMessage(cb: (message: EngineMessage) => void): () => void;
  onStatus(cb: (status: { connected: boolean }) => void): () => void;
  send(message: unknown): void;
  getStatus?(): Promise<{ connected: boolean }>;
  /** Desktop-only helpers. Missing in a plain browser. */
  pickFile?(): Promise<string | null>;
  getVersion?(): Promise<string>;
  openIssue?(title: string, body: string): Promise<{ opened: boolean; truncated?: boolean; reason?: string }>;
  updates?: UpdatesBridge;
  getAppSettings?(): Promise<AppSettings>;
  setAppSettings?(s: Partial<AppSettings>): Promise<AppSettings>;
}

export interface AppSettings {
  startWithWindows: boolean;
  minimizeToTray: boolean;
  autoUpdate: boolean;
  setupDone: boolean;
}

export type UpdateStatus =
  | { state: "dev" }
  | { state: "unconfigured" }
  | { state: "idle" }
  | { state: "checking" }
  | { state: "none" }
  | { state: "available"; version: string }
  | { state: "downloading"; percent: number }
  | { state: "ready"; version: string }
  | { state: "error"; message: string };

export interface UpdatesBridge {
  getStatus(): Promise<UpdateStatus>;
  check(): Promise<void>;
  download(): Promise<void>;
  install(): Promise<void>;
  onStatus(cb: (s: UpdateStatus) => void): () => void;
}

declare global {
  interface Window {
    kinetic?: KineticBridge;
  }
}

export interface EngineState {
  connected: boolean;
  version: string | null;
  paused: boolean;
  devices: DeviceInfo[];
  config: EngineConfig;
  /** Profile the engine is using right now, chosen by the app in front. */
  activeProfile: string;
  activeApp: string;
  shiftActive: boolean;
  dpi: DpiInfo | null;
  hardware: HardwareInfo | null;
  telemetry: Telemetry | null;
  /** Recent hand speed samples, oldest first, about one every 100 ms. */
  speedHistory: number[];
  apps: string[];
  runningMacros: ReadonlySet<string>;
  /** Buttons currently held down, by button number. */
  pressed: ReadonlySet<number>;
  /** The button pressed most recently, so the UI can follow what the user touches. */
  lastPressed: number | null;
  learn: LearnState;
  /** Buttons found by the setup guide that still need a name. */
  candidates: LearnCandidate[];
  measure: MeasureState;
  lastButton: ButtonEvent | null;
  report: DeviceReport | null;
  requestReport(): void;
  setConfig(config: EngineConfig): void;
  requestApps(): void;
  runMacro(id: string): void;
  stopMacros(): void;
  setPaused(paused: boolean): void;
  setStage(stage: number): void;
  setPolling(hz: number): void;
  learnStart(multi?: boolean): void;
  learnCancel(): void;
  learnConfirm(label: string, button?: number): void;
  measureStart(cm: number): void;
  measureFinish(): void;
  measureCancel(): void;
}

const HISTORY = 100;

export function useEngine(): EngineState {
  const [connected, setConnected] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [paused, setPausedState] = useState(false);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [config, setConfigState] = useState<EngineConfig>(EMPTY_CONFIG);
  const [activeProfile, setActiveProfile] = useState(DEFAULT_PROFILE);
  const [activeApp, setActiveApp] = useState("");
  const [shiftActive, setShiftActive] = useState(false);
  const [dpi, setDpi] = useState<DpiInfo | null>(null);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [speedHistory, setSpeedHistory] = useState<number[]>(() => Array(HISTORY).fill(0));
  const [apps, setApps] = useState<string[]>([]);
  const [runningMacros, setRunningMacros] = useState<ReadonlySet<string>>(new Set());
  const [pressed, setPressed] = useState<ReadonlySet<number>>(new Set());
  const [lastPressed, setLastPressed] = useState<number | null>(null);
  const [learn, setLearn] = useState<LearnState>({ state: "idle" });
  const [candidates, setCandidates] = useState<LearnCandidate[]>([]);
  const [measure, setMeasure] = useState<MeasureState>({ state: "idle" });
  const [lastButton, setLastButton] = useState<ButtonEvent | null>(null);
  const [report, setReport] = useState<DeviceReport | null>(null);
  const bridge = useRef(window.kinetic);

  useEffect(() => {
    const b = bridge.current;
    if (!b) return;
    // The connection may have been made before this page existed, so ask for it and for a fresh picture.
    b.getStatus?.().then((s) => {
      setConnected(s.connected);
      if (s.connected) b.send({ cmd: "snapshot" });
    }).catch(() => {});
    const offStatus = b.onStatus((s) => {
      setConnected(s.connected);
      if (!s.connected) {
        setPressed(new Set());
        setRunningMacros(new Set());
        setTelemetry(null);
      }
    });
    const offMsg = b.onMessage((m) => {
      switch (m.t) {
        case "hello":
          setVersion(m.version);
          break;
        case "devices":
          setDevices(m.devices);
          break;
        case "config":
          setConfigState(m.config);
          break;
        case "active":
          setActiveProfile(m.profile);
          setActiveApp(m.app);
          break;
        case "apps":
          setApps(m.apps);
          break;
        case "layer":
          setShiftActive(m.shift);
          break;
        case "engine":
          setPausedState(m.paused);
          break;
        case "dpi": {
          const { t: _t, ...info } = m;
          void _t;
          setDpi(info);
          break;
        }
        case "hardware": {
          const { t: _t, ...info } = m;
          void _t;
          setHardware(info);
          break;
        }
        case "telemetry": {
          const { t: _t, ...info } = m;
          void _t;
          setTelemetry(info);
          setSpeedHistory((prev) => [...prev.slice(1 - HISTORY), info.speed]);
          break;
        }
        case "report": {
          const { t: _t, ...r } = m;
          void _t;
          setReport(r);
          break;
        }
        case "measure": {
          const { t: _t, ...state } = m;
          void _t;
          setMeasure(state);
          break;
        }
        case "learn": {
          const { t: _t, ...state } = m;
          void _t;
          if (state.state === "candidates") {
            setCandidates(state.items);
          } else {
            setLearn(state);
            if (state.state === "idle") setCandidates([]);
          }
          break;
        }
        case "macro":
          setRunningMacros((prev) => {
            const next = new Set(prev);
            if (m.running) next.add(m.id);
            else next.delete(m.id);
            return next;
          });
          break;
        case "button":
          setPressed((prev) => {
            const next = new Set(prev);
            if (m.down) next.add(m.button);
            else next.delete(m.button);
            return next;
          });
          if (m.down) setLastPressed(m.button);
          setLastButton((prev) => ({ device: m.device, button: m.button, down: m.down, n: (prev?.n ?? 0) + 1 }));
          break;
      }
    });
    return () => {
      offStatus();
      offMsg();
    };
  }, []);

  const send = useCallback((message: unknown) => bridge.current?.send(message), []);
  const setConfig = useCallback((next: EngineConfig) => {
    setConfigState(next);
    bridge.current?.send({ cmd: "set_config", config: next });
  }, []);

  return {
    connected, version, paused, devices, config, activeProfile, activeApp, shiftActive, dpi, hardware, telemetry,
    speedHistory, apps, runningMacros, pressed, lastPressed, learn, candidates, measure, lastButton, report, setConfig,
    requestReport: useCallback(() => send({ cmd: "device_report" }), [send]),
    requestApps: useCallback(() => send({ cmd: "list_apps" }), [send]),
    runMacro: useCallback((id: string) => send({ cmd: "run_macro", id }), [send]),
    stopMacros: useCallback(() => send({ cmd: "stop_macros" }), [send]),
    setPaused: useCallback((p: boolean) => send({ cmd: "set_paused", paused: p }), [send]),
    setStage: useCallback((stage: number) => send({ cmd: "set_stage", stage }), [send]),
    setPolling: useCallback((hz: number) => send({ cmd: "set_polling", hz }), [send]),
    learnStart: useCallback((multi?: boolean) => send({ cmd: "learn_start", multi: !!multi }), [send]),
    learnCancel: useCallback(() => send({ cmd: "learn_cancel" }), [send]),
    measureStart: useCallback((cm: number) => send({ cmd: "measure_start", cm }), [send]),
    measureFinish: useCallback(() => send({ cmd: "measure_finish" }), [send]),
    measureCancel: useCallback(() => send({ cmd: "measure_cancel" }), [send]),
    learnConfirm: useCallback((label: string, button?: number) => send({ cmd: "learn_confirm", label, button }), [send]),
  };
}

// ---- helpers ------------------------------------------------------------------------------------

const MOUSE_NAMES: MouseButtonName[] = ["left", "right", "middle", "back", "forward"];
export const isMouseName = (s: string): s is MouseButtonName => (MOUSE_NAMES as string[]).includes(s);

/** "ctrl+shift+t" -> ["ctrl","shift","t"]. Empty input gives an empty list. */
export function parseCombo(text: string): string[] {
  return text
    .split("+")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Short, readable name for what a button does. */
export function describeAction(a: Action | undefined, fallback: string, macros: MacroDef[] = [], stages: number[] = []): string {
  if (!a) return fallback;
  switch (a.type) {
    case "key":
      return a.keys.map(cap).join(" + ");
    case "mouse":
      return `${cap(a.button)} click`;
    case "macro":
      return `Macro · ${macros.find((m) => m.id === a.id)?.name ?? "missing"}`;
    case "dpi": {
      const dpi = stages[a.stage];
      switch (a.op) {
        case "cycle": return "Cycle DPI stage";
        case "up": return "DPI up";
        case "down": return "DPI down";
        case "set": return `Set DPI${dpi ? ` · ${dpi}` : ""}`;
        case "hold": return `Hold DPI${dpi ? ` · ${dpi}` : ""}`;
      }
      return "DPI";
    }
    case "shift":
      return "Hold = Shift layer";
    case "launch":
      return `Launch · ${a.path.split(/[\\/]/).pop() ?? a.path}`;
    case "disabled":
      return "Disabled";
  }
}

export function getProfile(config: EngineConfig, id: string): Profile {
  return config.profiles.find((p) => p.id === id) ?? config.profiles[0];
}

export function withProfile(config: EngineConfig, id: string, change: (p: Profile) => Profile): EngineConfig {
  return { ...config, profiles: config.profiles.map((p) => (p.id === id ? change(p) : p)) };
}

/** Same stage numbers the engine would pick: the profile's DPI for a stage. */
export function stageDpi(perf: Perf, stage: number): [number, number] {
  const s = perf.stages[stage] ?? perf.stages[0];
  if (!s) return [perf.native_dpi, perf.native_dpi];
  return [s.dpi, perf.independent_xy ? s.dpi_y ?? s.dpi : s.dpi];
}
