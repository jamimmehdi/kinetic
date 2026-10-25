import { useEffect, useMemo, useState } from "react";
import { DEFAULT_PROFILE, useEngine } from "./engine";
import { AccelerationScreen } from "./screens/Acceleration";
import { ButtonsScreen } from "./screens/Buttons";
import { DashboardScreen } from "./screens/Dashboard";
import { MacrosScreen } from "./screens/Macros";
import { PerformanceScreen } from "./screens/Performance";
import { ProfilesScreen } from "./screens/Profiles";
import { SettingsScreen } from "./screens/Settings";
import { SessionsScreen } from "./screens/Sessions";
import { CrosshairScreen } from "./screens/Crosshair";
import { SteadyScreen } from "./screens/Steady";
import { Setup } from "./Setup";
import { TitleBar } from "./TitleBar";
import { DeviceDpiContext, useDeviceDpi } from "./deviceDpi";
import { DpiCalibrate } from "./DpiCalibrate";
import { SupportRequest } from "./SupportRequest";
import { ThemeContext, type Theme } from "./ui";

type Screen = "dashboard" | "buttons" | "performance" | "acceleration" | "steady" | "crosshair" | "sessions" | "macros" | "profiles" | "settings";

const NAV: { id: Screen; label: string; icon: string[] }[] = [
  { id: "dashboard", label: "Dashboard", icon: ["M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"] },
  { id: "buttons", label: "Buttons", icon: ["M6 9a6 6 0 0 1 12 0v6a6 6 0 0 1-12 0z", "M12 3v7"] },
  { id: "performance", label: "Performance", icon: ["M12 14l4-4", "M3.5 18a9 9 0 1 1 17 0"] },
  { id: "acceleration", label: "Acceleration", icon: ["M3 20c6 0 8-4 10-9s4-7 8-7"] },
  { id: "steady", label: "Steady hand", icon: ["M12 3v4M12 17v4M3 12h4M17 12h4", "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z"] },
  { id: "crosshair", label: "Crosshair", icon: ["M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z", "M12 1v6M12 17v6M1 12h6M17 12h6"] },
  { id: "sessions", label: "Sessions", icon: ["M4 20V10M10 20V4M16 20v-7M22 20H2"] },
  { id: "macros", label: "Macros", icon: ["M8 5l11 7-11 7z"] },
  { id: "profiles", label: "Profiles", icon: ["M12 3l9 5-9 5-9-5z", "M3 13l9 5 9-5"] },
];
// A gear, so it is not mistaken for the theme button's sun.
const SETTINGS_ICON = [
  "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
  "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
];
const COLLAPSE_ICON = ["M11 17l-5-5 5-5", "M18 17l-5-5 5-5"];
const EXPAND_ICON = ["M13 17l5-5-5-5", "M6 17l5-5-5-5"];

function loadSidebarOpen(): boolean {
  try {
    return localStorage.getItem("kinetic.sidebar") !== "closed";
  } catch {
    return true;
  }
}

function loadTheme(): Theme {
  try {
    const saved = localStorage.getItem("kinetic.theme");
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    // Storage can be unavailable; fall through to the system preference.
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function RailButton({ label, icon, on, open, onClick }: { label: string; icon: string[]; on: boolean; open: boolean; onClick(): void }) {
  return (
    <button type="button" className={`ri ${on ? "on" : ""} ${open ? "open" : ""}`} aria-label={label} aria-current={on ? "page" : undefined} title={label} onClick={onClick}>
      <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
        {icon.map((d) => <path key={d} d={d} />)}
      </svg>
      {open && <span className="ri-label">{label}</span>}
    </button>
  );
}

export function App() {
  const engine = useEngine();
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [sidebarOpen, setSidebarOpen] = useState(loadSidebarOpen);
  const toggleSidebar = () =>
    setSidebarOpen((open) => {
      try {
        localStorage.setItem("kinetic.sidebar", open ? "closed" : "open");
      } catch {
        // The choice is only a convenience.
      }
      return !open;
    });
  // Profile being edited on the Buttons, Performance, Acceleration and Profiles screens.
  // Not the same as the active one, which follows the app in front.
  const [editingProfile, setEditingProfile] = useState(DEFAULT_PROFILE);
  const editing = engine.config.profiles.some((p) => p.id === editingProfile) ? editingProfile : DEFAULT_PROFILE;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("kinetic.theme", theme);
    } catch {
      // Not persisting the theme is harmless.
    }
  }, [theme]);

  // The first-launch guide. null while we find out whether it was done before.
  const [setupDone, setSetupDone] = useState<boolean | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const deviceDpi = useDeviceDpi(engine);
  const [calibrating, setCalibrating] = useState(false);
  const [requesting, setRequesting] = useState(false);
  useEffect(() => {
    const fallback = () => {
      try { return localStorage.getItem("kinetic.setupDone") === "1"; } catch { return false; }
    };
    const get = window.kinetic?.getAppSettings;
    if (!get) { setSetupDone(fallback()); return; }
    get().then((s) => setSetupDone(s.setupDone)).catch(() => setSetupDone(fallback()));
  }, []);
  const finishSetup = () => {
    setSetupDone(true);
    setShowSetup(false);
    setScreen("dashboard");
    try { localStorage.setItem("kinetic.setupDone", "1"); } catch { /* storage unavailable */ }
    window.kinetic?.setAppSettings?.({ setupDone: true });
  };

  const themeValue = useMemo(() => ({ theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) }), [theme]);

  return (
    <ThemeContext.Provider value={themeValue}>
      <DeviceDpiContext.Provider value={deviceDpi}>
      <div className="app">
        <nav className={`rail ${sidebarOpen ? "open" : ""}`} aria-label="Main">
          <div className="rail-head">
            <div className="logo">
              <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="3" width="12" height="18" rx="6" /><path d="M12 3v7" /></svg>
            </div>
            {sidebarOpen && (
              <div className="rail-name">
                <b>Kinetic</b>
                <span className="sub">Mouse control</span>
              </div>
            )}
          </div>
          {NAV.map((n) => <RailButton key={n.id} label={n.label} icon={n.icon} on={screen === n.id} open={sidebarOpen} onClick={() => setScreen(n.id)} />)}
          <div style={{ flex: 1 }} />
          <RailButton label="Settings" icon={SETTINGS_ICON} on={screen === "settings"} open={sidebarOpen} onClick={() => setScreen("settings")} />
          <button
            type="button"
            className={`ri collapse ${sidebarOpen ? "open" : ""}`}
            aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
            aria-expanded={sidebarOpen}
            title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
            onClick={toggleSidebar}
          >
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              {(sidebarOpen ? COLLAPSE_ICON : EXPAND_ICON).map((d) => <path key={d} d={d} />)}
            </svg>
            {sidebarOpen && <span className="ri-label">Collapse</span>}
          </button>
        </nav>
        <div className="content">
        <TitleBar engine={engine} />
        <main className="main">
          {screen === "dashboard" && <DashboardScreen engine={engine} />}
          {screen === "buttons" && <ButtonsScreen engine={engine} profileId={editing} onProfileChange={setEditingProfile} />}
          {screen === "performance" && <PerformanceScreen engine={engine} profileId={editing} onProfileChange={setEditingProfile} />}
          {screen === "acceleration" && <AccelerationScreen engine={engine} profileId={editing} onProfileChange={setEditingProfile} />}
          {screen === "steady" && <SteadyScreen engine={engine} profileId={editing} onProfileChange={setEditingProfile} />}
          {screen === "crosshair" && <CrosshairScreen />}
          {screen === "sessions" && <SessionsScreen engine={engine} />}
          {screen === "macros" && <MacrosScreen engine={engine} />}
          {screen === "profiles" && (
            <ProfilesScreen
              engine={engine}
              profileId={editing}
              onSelect={setEditingProfile}
              onEditButtons={() => setScreen("buttons")}
              onEditPerformance={() => setScreen("performance")}
            />
          )}
          {screen === "settings" && <SettingsScreen engine={engine} onRunSetup={() => setShowSetup(true)} onCalibrate={() => setCalibrating(true)} onRequestSupport={() => setRequesting(true)} />}
        </main>
        </div>
        {(setupDone === false || showSetup) && <Setup engine={engine} onDone={finishSetup} onCalibrate={() => setCalibrating(true)} onRequestSupport={() => setRequesting(true)} />}
        {calibrating && <DpiCalibrate engine={engine} onSave={deviceDpi.save} onClose={() => setCalibrating(false)} />}
        {requesting && <SupportRequest engine={engine} calibrations={deviceDpi.calibrations} onClose={() => setRequesting(false)} />}
      </div>
      </DeviceDpiContext.Provider>
    </ThemeContext.Provider>
  );
}
