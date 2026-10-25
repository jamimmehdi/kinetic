import { cleanState, type CrosshairState } from "./crosshair";
import { demoSessions, summarize } from "./devSessions";
import {
  DEFAULT_PROFILE, EMPTY_CONFIG, stageDpi,
  type AppSettings, type EngineConfig, type EngineMessage, type KineticBridge, type LearnCandidate, type UpdateStatus,
} from "./engine";

const hwConnected = !location.search.includes("nohw");
const setupDoneKey = "kinetic.mock.setupDone";

/**
 * Stand-in for the Electron bridge when the UI runs in a plain browser during development.
 * It pretends the engine is connected, treats the number keys 1 to 6 as mouse buttons and
 * produces synthetic movement so the live parts of the UI have something to show.
 */
export function installDevMock() {
  if (window.kinetic) return;

  const messageListeners = new Set<(m: EngineMessage) => void>();
  let mockConnected = true;
  const statusListeners = new Set<(s: { connected: boolean; wanted?: boolean }) => void>();
  let config: EngineConfig = EMPTY_CONFIG;
  let stage = config.profiles[0].perf.active_stage;
  let paused = false;
  let demo = demoSessions();
  let measureTimer = 0;
  let tremorTimer = 0;
  let measureCm = 10;
  let measureCounts = () => 0;
  let moving = false;
  let pollingHz = 1000;
  let crosshairMock: CrosshairState = (() => {
    try { return cleanState(JSON.parse(localStorage.getItem("kinetic.mock.crosshair") ?? "null")); } catch { return cleanState(null); }
  })();
  let settings: AppSettings = {
    startWithWindows: true, minimizeToTray: true, autoUpdate: true, gameGuard: true, activityLog: false, blockedFailsafe: true, kernelMode: false, startEngineOnOpen: false,
    setupDone: (() => { try { return localStorage.getItem(setupDoneKey) === "1"; } catch { return false; } })(),
  };
  let candidates: LearnCandidate[] = [];
  const updateListeners = new Set<(s: UpdateStatus) => void>();
  let updateStatus: UpdateStatus = { state: "idle" };
  const setUpdate = (s: UpdateStatus) => { updateStatus = s; updateListeners.forEach((cb) => cb(s)); };
  const emit = (m: EngineMessage) => messageListeners.forEach((cb) => cb(m));
  const perf = () => config.profiles.find((p) => p.id === DEFAULT_PROFILE)!.perf;
  const dpiMessage = (): EngineMessage => {
    const [x, y] = stageDpi(perf(), stage);
    return { t: "dpi", stage, dpi_x: x, dpi_y: y, native: perf().native_dpi, stages: perf().stages.length, processing: false, hardware: perf().use_hardware, custom: false };
  };

  const bridge: KineticBridge = {
    onMessage(cb) {
      messageListeners.add(cb);
      queueMicrotask(() => {
        cb({ t: "hello", version: "dev-mock" });
        cb({ t: "devices", devices: [{ id: "mock", name: "Mouse 1532:0094", vid: 0x1532, pid: 0x94, buttons: 5, extras: [{ button: 6, label: "Top button" }] }] });
        cb({ t: "config", config });
        cb({ t: "active", profile: DEFAULT_PROFILE, app: "explorer.exe" });
        cb({ t: "engine", paused });
        cb({ t: "layer", shift: false });
        cb(dpiMessage());
        cb({ t: "sessions", sessions: demo.map(summarize), live: demo.filter((d) => d.live).map((d) => d.id) });
        for (const d of demo.filter((x) => x.live)) {
          cb({ t: "session_live", live: [{ id: d.id, exe: d.exe, name: d.name, started: d.started, state: "working", duration_ms: Date.now() - d.started, working_ms: Date.now() - d.started }] });
        }
        cb({ t: "saved", at: Date.now() - 90_000, path: "C:\\Users\\you\\AppData\\Roaming\\Kinetic\\config.json" });
        cb({ t: "hardware", connected: hwConnected, vendor: "Razer", dpi_x: stageDpi(perf(), stage)[0], dpi_y: stageDpi(perf(), stage)[1], polling_hz: pollingHz, polling_options: [125, 500, 1000], can_set_polling: true, can_set_dpi: true, battery: 69 });
      });
      return () => messageListeners.delete(cb);
    },
    onStatus(cb) {
      statusListeners.add(cb);
      queueMicrotask(() => cb({ connected: mockConnected, wanted: mockConnected }));
      return () => statusListeners.delete(cb);
    },
    send(message) {
      const m = message as { cmd?: string; config?: EngineConfig; id?: string; stage?: number; paused?: boolean };
      switch (m.cmd) {
        case "set_config":
          if (m.config) {
            // The engine keeps stages in ascending DPI order; do the same so the UI sees what it would.
            config = {
              ...m.config,
              profiles: m.config.profiles.map((p) => {
                const order = p.perf.stages.map((_, i) => i).sort((a, b) => p.perf.stages[a].dpi - p.perf.stages[b].dpi);
                return { ...p, perf: { ...p.perf, stages: order.map((i) => p.perf.stages[i]), active_stage: order.indexOf(p.perf.active_stage) } };
              }),
            };
            stage = perf().active_stage;
            emit({ t: "config", config });
            emit(dpiMessage());
          }
          break;
        case "list_apps":
          emit({ t: "apps", apps: ["chrome.exe", "code.exe", "notepad.exe", "valorant.exe"] });
          break;
        case "run_macro":
          if (m.id) {
            emit({ t: "macro", id: m.id, running: true });
            setTimeout(() => emit({ t: "macro", id: m.id!, running: false }), 600);
          }
          break;
        case "set_stage":
          stage = Math.min(m.stage ?? 0, perf().stages.length - 1);
          emit(dpiMessage());
          break;
        case "set_polling": {
          const hz = (m as { hz?: number }).hz;
          if (hz && [125, 500, 1000].includes(hz)) {
            pollingHz = hz;
            const [x, y] = stageDpi(perf(), stage);
            emit({ t: "hardware", connected: hwConnected, vendor: "Razer", dpi_x: x, dpi_y: y, polling_hz: pollingHz, polling_options: [125, 500, 1000], can_set_polling: true, can_set_dpi: true, battery: 69 });
          }
          break;
        }
        case "set_paused":
          paused = !!m.paused;
          emit({ t: "engine", paused });
          break;
        case "learn_start": {
          const multi = !!(m as { multi?: boolean }).multi;
          candidates = [];
          emit({ t: "learn", state: "listening", seconds: multi ? 180 : 6, multi });
          if (!multi) setTimeout(() => emit({ t: "learn", state: "found", button: 7 }), 1500);
          break;
        }
        case "sessions_list":
          emit({ t: "sessions", sessions: demo.map(summarize), live: demo.filter((d) => d.live).map((d) => d.id) });
          break;
        case "session_get": {
          const id = String((m as { id?: string }).id ?? "");
          emit({ t: "session", id, session: demo.find((d) => d.id === id) ?? null });
          break;
        }
        case "sessions_clear":
          demo = demo.filter((d) => d.live);
          emit({ t: "sessions", sessions: demo.map(summarize), live: demo.map((d) => d.id) });
          break;
        case "tremor_start": {
          const seconds = Number((m as { seconds?: number }).seconds) || 10;
          let ms = 0;
          emit({ t: "tremor", state: "running", elapsed_ms: 0, seconds, events: 0 });
          tremorTimer = window.setInterval(() => {
            ms += 250;
            if (ms >= seconds * 1000) {
              window.clearInterval(tremorTimer);
              tremorTimer = 0;
              emit({
                t: "tremor", state: "done", events: 1840, rms_counts: 5.1, rms_mm: 0.162, dominant_hz: 7.5, prominence: 12.4,
                peak_speed: 0.62, level: "medium", dpi: 800,
                suggestion: { precision: true, precision_below: 0.93, precision_factor: 0.6, speed_smoothing: 0.75 },
              });
            } else {
              emit({ t: "tremor", state: "running", elapsed_ms: ms, seconds, events: Math.round(ms * 0.9) });
            }
          }, 250);
          break;
        }
        case "tremor_cancel":
          if (tremorTimer) window.clearInterval(tremorTimer);
          tremorTimer = 0;
          emit({ t: "tremor", state: "idle" });
          break;
        case "kernel_refresh":
          emit({ t: "kernel", enabled: settings.kernelMode, driver: false, writer: false, active: false, error: null });
          break;
        case "activity_history":
          emit({
            t: "activity_history", enabled: true,
            entries: [
              { t: Date.now() - 6000, app: "valorant.exe", kind: "app", detail: { protected_game: true } },
              { t: Date.now() - 5000, app: "valorant.exe", kind: "button", detail: { button: 4, action: "key" } },
              { t: Date.now() - 4000, app: "valorant.exe", kind: "movement", detail: { sent: 812, delivered: 812, worked: true } },
              { t: Date.now() - 3000, app: "valorant.exe", kind: "injected_input", detail: { accepted: 2, refused: 0, worked: true } },
              { t: Date.now() - 2000, app: "valorant.exe", kind: "movement", detail: { sent: 640, delivered: 0, worked: false } },
              { t: Date.now() - 1000, app: "valorant.exe", kind: "engine", detail: { stepped_aside: "blocked" } },
            ],
          });
          break;
        case "device_report":
          emit({
            t: "report", engine: "0.1.0", windows: "Windows_NT",
            devices: [{ vid: "0x342D", pid: "0xE484", name: "Mouse 342D:E484", buttons: 8, interfaces: [{ interface: 0, usage_page: "0x0001", usage: "0x0002", product: "Mock mouse", manufacturer: "Mock", release: "0x0100" }], learned_buttons: [] }],
          });
          break;
        case "measure_start": {
          const cm = Number((m as { cm?: number }).cm) || 10;
          let counts = 0;
          emit({ t: "measure", state: "running", cm, counts, device: "mock" });
          measureTimer = window.setInterval(() => {
            counts += 90;
            emit({ t: "measure", state: "running", cm, counts, device: "mock" });
          }, 100);
          measureCm = cm;
          measureCounts = () => counts;
          break;
        }
        case "measure_finish": {
          if (measureTimer) window.clearInterval(measureTimer);
          measureTimer = 0;
          const counts = measureCounts();
          emit({ t: "measure", state: "done", cm: measureCm, counts, device: "mock", dpi: Math.round((counts / (measureCm / 2.54)) / 50) * 50 });
          break;
        }
        case "measure_cancel":
          if (measureTimer) window.clearInterval(measureTimer);
          measureTimer = 0;
          emit({ t: "measure", state: "idle" });
          break;
        case "learn_cancel":
          candidates = [];
          emit({ t: "learn", state: "idle" });
          break;
        case "learn_confirm": {
          const b = (m as { button?: number }).button;
          candidates = candidates.filter((c) => c.button !== b);
          if (b === undefined) emit({ t: "learn", state: "idle" });
          else emit({ t: "learn", state: "candidates", items: candidates });
          break;
        }
      }
    },
    pickFile: async () => "C:\\Windows\\notepad.exe",
    pickProgram: async () => "C:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe",
    getAppSettings: async () => ({ ...settings }),
    setAppSettings: async (s) => {
      settings = { ...settings, ...s };
      try { localStorage.setItem(setupDoneKey, settings.setupDone ? "1" : "0"); } catch { /* storage unavailable */ }
      return { ...settings };
    },
    getVersion: async () => "0.1.0",
    crosshair: {
      get: async () => crosshairMock,
      set: async (s) => {
        crosshairMock = cleanState(s);
        try { localStorage.setItem("kinetic.mock.crosshair", JSON.stringify(crosshairMock)); } catch { /* storage unavailable */ }
        return crosshairMock;
      },
      displays: async () => ["Monitor 1 · 2560×1440 · main", "Monitor 2 · 1920×1080"],
      hotkeyOk: async () => true,
      onState: () => () => {},
    },
    startup: {
      getStatus: async () => ({ state: "ok" as const }),
      repair: async () => ({ state: "ok" as const }),
      openWindowsSettings: async () => {},
    },
    exportSettings: async () => "C:\\Users\\you\\Documents\\kinetic-settings.json",
    importSettings: async () => ({ cancelled: true }),
    openIssue: async (title, body) => {
      try { await navigator.clipboard.writeText(body); } catch { /* clipboard unavailable */ }
      window.open(`https://github.com/jamimmehdi/kinetic/issues/new?title=${encodeURIComponent(title)}`, "_blank");
      return { opened: true, truncated: true };
    },
    getStatus: async () => ({ connected: mockConnected, wanted: mockConnected }),
    engine: {
      start: async () => {
        statusListeners.forEach((l) => l({ connected: false, wanted: true }));
        window.setTimeout(() => {
          mockConnected = true;
          statusListeners.forEach((l) => l({ connected: true, wanted: true }));
        }, 900);
      },
      stop: async () => {
        mockConnected = false;
        statusListeners.forEach((l) => l({ connected: false, wanted: false }));
      },
    },
    win: {
      minimize: async () => {},
      toggleMaximize: async () => {},
      close: async () => {},
      isMaximized: async () => false,
      onMaximized: () => () => {},
    },
    updates: {
      getStatus: async () => updateStatus,
      onStatus(cb) { updateListeners.add(cb); return () => updateListeners.delete(cb); },
      check: async () => {
        setUpdate({ state: "checking" });
        setTimeout(() => setUpdate({ state: "available", version: "0.2.0" }), 900);
      },
      download: async () => {
        let p = 0;
        const timer = setInterval(() => {
          p += 20;
          if (p >= 100) { clearInterval(timer); setUpdate({ state: "ready", version: "0.2.0" }); } else setUpdate({ state: "downloading", percent: p });
        }, 400);
      },
      install: async () => {},
    },
  };

  const press = (e: KeyboardEvent, down: boolean) => {
    const el = e.target as HTMLElement | null;
    if (el && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return;
    if (e.repeat || !/^[1-7]$/.test(e.key)) return;
    if (e.key === "7") {
      // Key 7 plays an unknown button: the setup guide offers it once it has been pressed and released.
      if (!down && !candidates.some((c) => c.button === 7)) {
        candidates = [...candidates, { button: 7, vid: 0x1532, pid: 0x94 }];
        emit({ t: "learn", state: "candidates", items: candidates });
      }
      return;
    }
    emit({ t: "button", device: "mock", button: Number(e.key), down });
  };
  window.addEventListener("keydown", (e) => press(e, true));
  window.addEventListener("keyup", (e) => press(e, false));

  // Hold the M key to "move the mouse": synthetic speed for the graphs.
  window.addEventListener("keydown", (e) => { if (e.key === "m" && !(e.target as HTMLElement).matches?.("input,textarea")) moving = true; });
  window.addEventListener("keyup", (e) => { if (e.key === "m") moving = false; });
  let t = 0;
  setInterval(() => {
    t += 0.1;
    const speed = moving ? 3 + 2.5 * Math.sin(t * 2.2) + 1.5 * Math.sin(t * 5.1) : 0;
    emit({ t: "telemetry", speed: Math.max(speed, 0), hz: 998, latency_ms: 0.2, mult: 1, moving });
  }, 100);

  window.kinetic = bridge;
}
