import { useContext, useEffect, useState } from "react";
import { ThemeContext, Toggle, Top } from "../ui";
import type { AppSettings, EngineState, UpdateStatus } from "../engine";

const ANY = [
  ["Global button remapping", "Low-level hooks, works in every app"],
  ["Shift layers (Hypershift style)", "Hold a button to unlock a second map"],
  ["Macro builder", "Keys, clicks, movement, ms delays, loops"],
  ["Per-app profile auto-switching", "Follows the foreground window"],
  ["DPI stages and independent X / Y", "Emulated by scaling movement in software"],
  ["Acceleration curves, rotation, smoothing, angle snapping", "Sigmoid, natural, power, drawn curves"],
  ["Scroll: lines per notch, smooth, reverse", "Applied while the profile is active"],
  ["Polling rate monitor", "Measures the real rate, read only"],
];
const DEVICE = [
  ["Razer mice: DPI, polling rate and battery", "Supported now, over Razer's own HID protocol"],
  ["Real hardware DPI", "Written to the sensor over HID"],
  ["Polling rate change", "125, 500 or 1000 Hz on the Razer mouse tested; other brands need their own module"],
  ["Idle polling ramp-down and sleep timers", ""],
  ["Lift-off distance and surface calibration", ""],
  ["Motion sync", ""],
  ["On-board profile and macro storage", "Keeps working without the app running"],
  ["Battery level", ""],
];
const NOT = [
  ["Changing polling rate on an unsupported mouse", "Fixed by firmware and the USB descriptor"],
  ["Lift-off, motion sync or surface tuning on a basic mouse", "The sensor has no such setting to reach"],
  ["Software DPI above the sensor's native count", "Scaling up cannot add real detail"],
  ["Reading the sensor's true DPI", "Windows never reports it"],
];

/** Version, update status and the buttons that go with each state. */
function UpdatesCard({ version, status, autoUpdate, onAuto }: { version: string; status: UpdateStatus; autoUpdate: boolean; onAuto(v: boolean): void }) {
  const u = window.kinetic?.updates;
  const message: Record<UpdateStatus["state"], string> = {
    dev: "Updates work in the installed app, not while developing.",
    unconfigured: "This build has no update source yet. See the README, \"Releasing updates\".",
    idle: "Not checked yet.",
    checking: "Checking for a new version…",
    none: "You're on the latest version.",
    available: "",
    downloading: "",
    ready: "",
    error: "",
  };
  let text = message[status.state];
  if (status.state === "available") text = `Version ${status.version} is available.`;
  if (status.state === "downloading") text = `Downloading… ${status.percent}%`;
  if (status.state === "ready") text = `Version ${status.version} is downloaded and ready.`;
  if (status.state === "error") text = `Could not check: ${status.message}`;
  const canCheck = ["dev", "unconfigured", "idle", "none", "error"].includes(status.state);
  const [asked, setAsked] = useState(false);
  const busy = status.state === "checking" || status.state === "downloading";

  return (
    <div className="card" style={{ padding: "6px 22px", flex: "none" }}>
      <div className="row plain">
        <span>Kinetic {version && <span className="num sub">v{version}</span>}<span className="sub" style={{ display: "block", fontSize: 12 }} role="status">{text}{asked && (status.state === "dev" || status.state === "unconfigured") ? " (Nothing to check yet.)" : ""}</span></span>
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {status.state === "downloading" && (
            <span className="trk" style={{ width: 120, cursor: "default" }} role="progressbar" aria-valuenow={status.percent} aria-valuemin={0} aria-valuemax={100}>
              <span className="fil" style={{ width: `${status.percent}%` }} />
            </span>
          )}
          {(canCheck || busy) && <button type="button" className="btn2" disabled={!u || busy} onClick={() => { setAsked(true); u?.check(); }}>{status.state === "checking" ? "Checking…" : "Check for updates"}</button>}
          {status.state === "available" && <button type="button" className="btn" style={{ height: 36 }} onClick={() => u?.download()}>Download</button>}
          {status.state === "ready" && <button type="button" className="btn" style={{ height: 36 }} onClick={() => u?.install()}>Restart and update</button>}
        </span>
      </div>
      <div className="row plain" style={{ borderTop: "1px solid var(--bd)" }}>
        <span>Check for updates automatically<span className="sub" style={{ display: "block", fontSize: 12 }}>On startup and every few hours. Nothing installs until you say so.</span></span>
        <Toggle label="Check for updates automatically" on={autoUpdate} onChange={onAuto} />
      </div>
    </div>
  );
}

function Column({ tag, tagStyle, title, items, border, note }: { tag: string; tagStyle: React.CSSProperties; title: string; items: string[][]; border?: string; note?: string }) {
  return (
    <div className="card" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 6, borderColor: border }}>
      <span className="tag" style={{ ...tagStyle, alignSelf: "flex-start", textTransform: "uppercase", letterSpacing: ".04em" }}>{tag}</span>
      <h2 style={{ fontSize: 16, fontWeight: 650, margin: "8px 0 6px" }}>{title}</h2>
      {items.map(([t, s]) => (
        <div key={t} style={{ display: "flex", gap: 10, padding: "9px 0", borderBottom: "1px solid var(--bd)", fontSize: 14, lineHeight: 1.35 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", marginTop: 6, flex: "none", background: tagStyle.color as string }} />
          <div>{t}{s && <span className="sub" style={{ display: "block", fontSize: 12, marginTop: 2 }}>{s}</span>}</div>
        </div>
      ))}
      {note && <div style={{ flex: 1, display: "flex", alignItems: "flex-end" }}><div className="stat sub" style={{ fontSize: 13 }}>{note}</div></div>}
    </div>
  );
}

export function SettingsScreen({ engine, onRunSetup, onCalibrate, onRequestSupport }: { engine: EngineState; onRunSetup(): void; onCalibrate(): void; onRequestSupport(): void }) {
  const { theme, toggle } = useContext(ThemeContext);
  const [app, setApp] = useState<AppSettings | null>(null);
  const [version, setVersion] = useState("");
  const [upd, setUpd] = useState<UpdateStatus>({ state: "idle" });
  useEffect(() => {
    window.kinetic?.getAppSettings?.().then(setApp).catch(() => setApp(null));
    window.kinetic?.getVersion?.().then(setVersion).catch(() => {});
    const u = window.kinetic?.updates;
    u?.getStatus().then(setUpd).catch(() => {});
    return u?.onStatus(setUpd);
  }, []);
  const change = (patch: Partial<AppSettings>) => window.kinetic?.setAppSettings?.(patch).then(setApp);

  return (
    <>
      <Top title="Settings" sub="Application settings, and what the app can really do on your mouse." />
      <div className="scroll-y" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 18 }}>
      <div className="card" style={{ padding: "6px 22px", flex: "none" }}>
        <div className="row plain"><span>Dark theme</span><Toggle label="Dark theme" on={theme === "dark"} onChange={toggle} /></div>
        <div className="row plain" style={{ borderTop: "1px solid var(--bd)" }}>
          <span>Start with Windows<span className="sub" style={{ display: "block", fontSize: 12 }}>Opens Kinetic in the tray at sign-in so remaps work straight away</span></span>
          <Toggle label="Start with Windows" on={!!app?.startWithWindows} disabled={!app} onChange={(v) => change({ startWithWindows: v })} />
        </div>
        <div className="row plain" style={{ borderTop: "1px solid var(--bd)" }}>
          <span>Keep running in the tray when the window is closed<span className="sub" style={{ display: "block", fontSize: 12 }}>The engine keeps your remaps working</span></span>
          <Toggle label="Keep running in the tray" on={!!app?.minimizeToTray} disabled={!app} onChange={(v) => change({ minimizeToTray: v })} />
        </div>
        <div className="row plain" style={{ borderTop: "1px solid var(--bd)" }}>
          <span>Engine</span>
          <span className="sub">{engine.connected ? `Running · version ${engine.version ?? "?"}` : "Not running"}</span>
        </div>
        <div className="row plain" style={{ borderTop: "1px solid var(--bd)" }}>
          <span>First-launch setup<span className="sub" style={{ display: "block", fontSize: 12 }}>Press each button on your mouse once so the app knows how many it has</span></span>
          <button type="button" className="btn2" onClick={onRunSetup}>Run again</button>
        </div>
        <div className="row plain" style={{ borderTop: "1px solid var(--bd)" }}>
          <span>DPI stages<span className="sub" style={{ display: "block", fontSize: 12 }}>Learn your mouse's DPI button and the DPI of each stage so the app follows it</span></span>
          <button type="button" className="btn2" onClick={onCalibrate}>Calibrate</button>
        </div>
        <div className="row plain" style={{ borderTop: "1px solid var(--bd)" }}>
          <span>Mouse not fully supported?<span className="sub" style={{ display: "block", fontSize: 12 }}>Send the details to GitHub so support can be added in an update</span></span>
          <button type="button" className="btn2" onClick={onRequestSupport}>Request support</button>
        </div>
      </div>

      <UpdatesCard version={version} status={upd} autoUpdate={!!app?.autoUpdate} onAuto={(v) => change({ autoUpdate: v })} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 18, flex: "none", alignItems: "stretch" }}>
        <Column tag="Any mouse · software" tagStyle={{ background: "var(--oks)", color: "var(--ok)" }} title="Built into the core engine" items={ANY} border="var(--ok)" />
        <Column tag="Supported devices · driver" tagStyle={{ background: "var(--wns)", color: "var(--wn)" }} title="Needs each brand's protocol" items={DEVICE} border="var(--wn)" />
        <Column
          tag="Not possible"
          tagStyle={{ background: "var(--sub)", color: "var(--mu)" }}
          title="Limits of software"
          items={NOT}
          note="Every control is marked with its type, so nothing looks usable when it is not."
        />
      </div>
      </div>
    </>
  );
}
